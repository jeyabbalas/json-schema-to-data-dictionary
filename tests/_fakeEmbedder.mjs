// Deterministic bag-of-words embedder for tests: each token is hashed into one of `dims`
// buckets; a tiny synonym map makes "climacteric" land next to "menopause" and "cigarette"
// next to "tobacco". Vectors are unit-normalized so dot products are cosine similarities.

const SYNONYMS = {
  climacteric: "meno", menopause: "meno", menopausal: "meno", meno: "meno",
  cigarette: "tobacco", cigarettes: "tobacco", smoking: "tobacco", smoke: "tobacco", smoker: "tobacco", tobacco: "tobacco"
};

function fnv(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createFakeEmbedder({ dims = 512, id = "fake-bow-v1", minScore = 0.3, delayMs = 0, failOn, failLoad } = {}) {
  const calls = { document: 0, query: 0, texts: [] };

  function vec(text) {
    const v = new Float32Array(dims);
    for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const token = SYNONYMS[raw] ?? raw;
      v[fnv(token) % dims] += 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i += 1) v[i] /= norm;
    return v;
  }

  return {
    id,
    minScore,
    calls,
    async load(onProgress) {
      if (failLoad) throw new Error(failLoad);
      onProgress?.(0.5);
      onProgress?.(1);
    },
    async embed(texts, kind) {
      calls[kind] += texts.length;
      calls.texts.push(...texts);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      for (const t of texts) if (failOn && t.includes(failOn)) throw new Error(`fail: ${failOn}`);
      return texts.map(vec);
    }
  };
}

/** A tiny hand-built DataDictionaryTable (no schema parsing) for deterministic tests. */
export function syntheticTable(extraLabels = 0) {
  const row = (name, description, values = []) => ({
    "Variable name": name,
    "Description": description,
    "Data type": "string",
    "Format": "",
    "Valid values": values,
    "Constraints": [],
    "Additional information": null
  });
  const many = Array.from({ length: extraLabels }, (_, i) => ({ value: i, label: `Option ${i}`, kind: "value" }));
  const rows = [
    row("meno_status", "Menopausal status at baseline", [
      { value: 1, label: "Premenopausal", kind: "value" },
      { value: 2, label: "Postmenopausal", kind: "value" },
      { value: 888, label: "Missing", kind: "sentinel" }
    ]),
    row("tobacco_use", "Tobacco use history", [
      { value: 0, label: "Never", kind: "value" },
      { value: 1, label: "Former", description: "Quit more than a year ago", kind: "value" },
      ...many
    ]),
    row("height_cm", "Standing height in centimetres", [{ value: null, label: "100–250", kind: "measurement" }]),
    row("age", "Age at questionnaire completion in years", [])
  ];
  return {
    title: "Synthetic",
    rows,
    categories: [
      { id: "a", title: "Reproductive", rows: rows.slice(0, 2) },
      { id: "b", title: "Anthropometry", rows: rows.slice(2) }
    ],
    conditionalRules: [],
    warnings: []
  };
}
