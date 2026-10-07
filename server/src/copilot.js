// Feature-request analyst. Uses the Anthropic Messages API when ANTHROPIC_API_KEY is set,
// otherwise falls back to a simple rule-based card. It ANALYSES only: it never edits or deploys code.
const SYSTEM = `أنت مهندس برمجيات يحلل طلبات ميزات جديدة لتطبيق "ثقافة وطن للمستلزمات العسكرية" (سوق متعدد التجار: محفظة داخلية، ضمان مالي 35 يوماً، خزنة برمزين، دفع عند الاستلام، مناديب، عمل دون إنترنت).
أجب بـ JSON فقط، بلا أي نص آخر، بهذا الشكل:
{"summary":"...","feasibility":"high|medium|low","impact":"...","risks":["..."],"conflicts":["ميزات قائمة قد تتأثر"],"better_alternatives":["..."],"effort":"small|medium|large"}
كن صريحاً: إن كانت الميزة تمس الأموال أو الأمن أو تخالف شروط منصة، فاذكر ذلك في risks.`;

export function extractJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no json');
  return JSON.parse(m[0]);
}

export function normalizeCard(raw, request) {
  const arr = (v) => (Array.isArray(v) ? v.map(String).slice(0, 10) : []);
  const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
  return {
    request,
    summary: String(raw.summary ?? '').slice(0, 600),
    feasibility: pick(raw.feasibility, ['high', 'medium', 'low'], 'medium'),
    impact: String(raw.impact ?? '').slice(0, 600),
    risks: arr(raw.risks), conflicts: arr(raw.conflicts), better_alternatives: arr(raw.better_alternatives),
    effort: pick(raw.effort, ['small', 'medium', 'large'], 'medium'),
  };
}

export function anthropicAnalyzer({ apiKey, model = 'claude-sonnet-5-5', fetchImpl = fetch } = {}) {
  if (!apiKey) return null;
  return async (request, context) => {
    const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1200, system: SYSTEM, messages: [{ role: 'user', content: `الميزات الحالية: ${context}\n\nالطلب:\n${request}` }] }),
    });
    if (!r.ok) throw new Error(`llm ${r.status}`);
    const data = await r.json();
    return extractJson(data.content?.map((b) => b.text ?? '').join('') ?? '');
  };
}

export function ruleBasedAnalyzer(features) {
  return async (request) => {
    const touched = features.filter((f) => request.includes(f.label.split(' ')[0]));
    const sensitive = /(دفع|محفظة|سحب|رصيد|خزنة|كلمة|رمز|بطاقة)/.test(request);
    return {
      summary: 'تحليل مبدئي بدون نموذج لغوي؛ اضبط ANTHROPIC_API_KEY لتحليل أدق.',
      feasibility: 'medium', impact: 'يتطلب مراجعة هندسية',
      risks: sensitive ? ['الطلب يمس الأموال أو الأمن: يلزم تصميم ومراجعة واختبارات قبل الاعتماد'] : [],
      conflicts: touched.map((f) => f.label), better_alternatives: [], effort: 'medium',
    };
  };
}
