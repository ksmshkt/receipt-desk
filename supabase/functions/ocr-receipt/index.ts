import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Plan name -> monthly OCR cap (null = unlimited). Add a key here and flip a
// user's receipt_desk_profiles.plan via SQL to introduce new tiers — no schema change needed.
const PLAN_LIMITS: Record<string, number | null> = {
  free: 30,
  admin: null,
  // future example: paid_100: 100, paid_300: 300,
};
const DEFAULT_PLAN = "free";

// Edge Functions run in UTC, but the free-tier reset should follow Japan's
// calendar month, not the server's — otherwise the reset lags by up to 9
// hours after midnight JST on the 1st.
function currentMonthKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  return `${year}-${month}`;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    date: { type: ["string", "null"], description: "レシートの日付。YYYY-MM-DD形式。読み取れない場合はnull" },
    store_name: {
      type: ["string", "null"],
      description:
        "店名・取引先名。最優先はレシートに文字で印字されている正式な店名（チェーン名と支店名が別々に印字されている場合は両方含める。例：「サンマルクカフェ 渋谷店」）。文字による店名の印字がない、またはロゴ・マークのみで判別しづらい場合に限り、ロゴのデザインからブランドを推測してよい。印字文字とロゴ推測が食い違う場合は印字文字を優先する。それでも読み取れない場合はnull",
    },
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

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: existingProfile } = await adminClient
      .from("receipt_desk_profiles")
      .select("plan, ocr_month, ocr_count")
      .eq("user_id", user.id)
      .maybeSingle();

    const currentMonth = currentMonthKey();
    const profile = existingProfile ?? { plan: DEFAULT_PLAN, ocr_month: null, ocr_count: 0 };
    const currentCount = profile.ocr_month === currentMonth ? profile.ocr_count : 0;
    // Note: can't use `PLAN_LIMITS[plan] ?? fallback` here — admin's limit is
    // legitimately `null` (unlimited), and `??` treats null as "missing" too,
    // which would wrongly fall back to the free tier's cap.
    const limit = profile.plan in PLAN_LIMITS ? PLAN_LIMITS[profile.plan] : PLAN_LIMITS[DEFAULT_PLAN];

    if (limit !== null && currentCount >= limit) {
      return new Response(
        JSON.stringify({ error: `今月のOCR利用上限（${limit}件）に達しました。来月になるとリセットされます。` }),
        { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
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

    // Record usage regardless of plan (useful for cost visibility even for
    // admin/paid) — the enforced cap above already handled who gets blocked.
    // Preserve the existing plan value here so admin/paid never gets reset
    // back to the 'free' column default on upsert.
    await adminClient.from("receipt_desk_profiles").upsert(
      { user_id: user.id, plan: profile.plan, ocr_month: currentMonth, ocr_count: currentCount + 1 },
      { onConflict: "user_id" },
    );

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
