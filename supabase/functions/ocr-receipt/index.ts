const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    date: { type: ["string", "null"], description: "レシートの日付。YYYY-MM-DD形式。読み取れない場合はnull" },
    store_name: { type: ["string", "null"], description: "店名・取引先名。読み取れない場合はnull" },
    amount: { type: ["integer", "null"], description: "合計金額（円、税込）。読み取れない場合はnull" },
    is_qualified: {
      type: "boolean",
      description: "適格請求書（インボイス）かどうか。T+13桁の登録番号がレシート上に記載されていればtrue、なければfalse",
    },
    tax_rate: {
      type: ["integer", "null"],
      description: "消費税率。10（標準税率）または8（軽減税率、飲食料品のテイクアウト・持ち帰りなど）。判別できない場合はnull",
    },
    payment_method: {
      type: ["string", "null"],
      description: "支払い方法。レシートに記載されている文字列をそのまま読み取る（例：「現金」「VISA」「PayPay支払」など）。読み取れない場合はnull",
    },
  },
  required: ["date", "store_name", "amount", "is_qualified", "tax_rate", "payment_method"],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { image_base64, media_type } = await req.json();
    if (!image_base64 || !media_type) {
      return new Response(JSON.stringify({ error: "image_base64 and media_type are required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type, data: image_base64 } },
              {
                type: "text",
                text: "この日本のレシート画像から、日付・店名・合計金額・適格請求書かどうか・消費税率（8%か10%か）・支払い方法を読み取ってください。",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: errText }), {
        status: response.status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const textBlock = data.content?.find((b: { type: string }) => b.type === "text");
    if (!textBlock) {
      return new Response(JSON.stringify({ error: "no text block in response" }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response(textBlock.text, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
