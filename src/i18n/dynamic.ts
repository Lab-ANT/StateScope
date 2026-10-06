import { getLang } from "./core";

// Translation layer for strings the backend sends.
//
// The engine and data layer are English-first: dataset metadata, channel/series/state names
// and error messages all come back in English. This module renders them in Chinese when the
// UI language is `zh`. Dictionaries are grouped by the backend file they mirror, so a change
// there has an obvious counterpart here.
//
// Lookup order: whole-string match -> known id-prefixed forms -> known error patterns ->
// term-by-term substitution (longest first, for composite names) -> unchanged.

const isZh = () => getLang() === "zh";

// ── Dataset metadata (data/preprocess/*.py <DS>_INFO, data/loaders/synthetic.py) ─────────
interface DatasetText {
  label: string;
  background: string;
  note: string;
  source?: string;
}

const DATASETS_ZH: Record<string, DatasetText> = {
  synthetic_abstract: {
    label: "抽象合成（级联状态）",
    background:
      "无业务命名的可复现合成数据：多条序列共享同一状态词表、彼此带时滞级联，并注入冗余/噪声通道。" +
      "自带逐时间步真值，可端到端算 ARI。",
    note: "",
    source: "StateScope 合成生成器（Hadamard 正交码电平 + 时滞级联）",
  },
  petshop: {
    label: "PetShop（真实微服务 RCA）",
    background:
      "AWS 上真实宠物领养微服务应用（temporal 场景，负载随时间起伏）的运行指标：每个服务 5 个真实" +
      "指标（延迟均值/p90/p99、请求量、可用率）+ 注入的噪声通道，1652 步。可用率在 noissue 基线近似" +
      "恒定、注入噪声无状态结构，因此阶段 2 的无标注选择器按信息量排序，K=4 时保留延迟/请求量这类" +
      "动态指标。含真实服务依赖图与注入故障的根因标签。",
    note: "含 2 个注入的演示用噪声通道（n_decoys 可调，名以 noise 开头）；其余为真实采集指标。",
    source: "Hardt et al., CLeaR 2024 · amazon-science/petshop-root-cause-analysis · CC-BY-4.0",
  },
  lemma_rca: {
    label: "LEMMA-RCA（真实多域 RCA）",
    background:
      "真实多域根因分析基准（NEC 微服务 / 云计算）：每个 pod 6 个运行指标（CPU、内存、收发包率、" +
      "收发带宽），分块平均降采样到约 6000 步，含 pod→node 放置拓扑。真值为故障根因标签，而非逐时刻状态。",
    note: "原始数据需放在 data_origin/lemma_rca/（CC-BY-ND，不入库）；首次使用自动预处理并缓存。",
  },
  wadi: {
    label: "WADI（真实配水测试床）",
    background:
      "真实配水 SCADA 测试床：三个相位（P1 主网格 → P2 次网格 → P3 回水网格）各由独立 PLC 控制、" +
      "水流单向流动。每个相位是一个实体，相位内精选连续传感器为指标，于是跨相位的状态因果对应物理" +
      "水流传播。16 天连续运行含 15 次攻击（约 6% 样本）。真值为攻击/正常二值，随 extra 提供。",
    note: "原始数据需放在 data_origin/WaDi.zip（SUTD iTrust 协议，不入库）；首次使用自动预处理并缓存。",
    source: "SUTD iTrust · WADI.A2_19 Nov 2019 · Ahmed et al., CySWATER 2017 · 需签署协议、不可再分发",
  },
};

export function datasetLabel(id: string, fallback: string): string {
  return (isZh() && DATASETS_ZH[id]?.label) || fallback;
}
export function datasetBackground(id: string, fallback: string): string {
  return (isZh() && DATASETS_ZH[id]?.background) || fallback;
}
export function datasetNote(id: string, fallback: string): string {
  return (isZh() && DATASETS_ZH[id]?.note) || fallback;
}
export function datasetSource(id: string, fallback: string): string {
  return (isZh() && DATASETS_ZH[id]?.source) || fallback;
}

// ── Term table ──────────────────────────────────────────────────────────────────────────
// Channel, series and phase names (data/preprocess/{petshop,lemma_rca,wadi}.py), plus the
// error messages emitted by src_api/.
const TERMS: Record<string, string> = {
  // PetShop channels
  "latency p90": "延迟p90",
  "latency p99": "延迟p99",
  latency: "延迟",
  requests: "请求量",
  availability: "可用率",
  "noise white": "噪声 · 白噪声",
  "noise jitter": "噪声 · 抖动",
  "noise background": "噪声 · 背景",
  "noise hiss": "噪声 · 杂讯",
  // LEMMA-RCA channels
  CPU: "CPU",
  memory: "内存",
  "rx bandwidth": "接收带宽",
  "tx bandwidth": "发送带宽",
  "rx packet rate": "收包率",
  "tx packet rate": "发包率",
  // WADI phases
  "P1 primary grid": "P1 主网格",
  "P2 secondary grid": "P2 次网格",
  "P3 return grid": "P3 回水网格",
  // Backend errors (src_api/session.py)
  "This dataset has no ground-truth state labels; use the unlabeled selector.":
    "该数据集无真值状态标注，请改用「无标注」选择方法。",
  "Run state detection first.": "请先运行状态检测。",
  "Nothing to detect: select at least one metric of one entity in indicator selection first.":
    "没有可检测的序列：请先在指标选择中选中至少一个实体的指标。",
  "Select at least one metric of one entity.": "至少选择一个实体的一个指标。",
};

// Id-prefixed forms produced by the backend.
const PREFIXES: [RegExp, string][] = [
  [/^state (\d+)$/, "状态 $1"],
  [/^metric(\d+)$/, "指标$1"],
  [/^distractor(\d+)$/, "干扰$1"],
];

// Error messages with interpolated values (src_api/, data/preprocess/).
const ERRORS: [RegExp, string][] = [
  [/^unknown series '(.+)'$/, "未知序列「$1」"],
  [/^segments of '(.+)' must cover \[0, (\d+)\) exactly$/, "「$1」的段必须完整覆盖 [0, $2)"],
  [
    /^segments of '(.+)' must be contiguous, non-empty and have state id >= 0$/,
    "「$1」的段必须连续、非空，且状态 id ≥ 0",
  ],
  [/^unknown dataset '(.+)'\. available: (.*)$/, "未知数据集「$1」，可选：$2"],
  [/^dataset '(.+)' is listed but not integrated: (.*)$/, "数据集「$1」已登记但未集成：$2"],
  [/raw data missing:/, "原始数据缺失："],
  [/^Unknown entity '(.+)'\.$/, "未知实体「$1」。"],
  [/^Entity '(.+)' has no metric (.+)\.$/, "实体「$1」没有指标 $2。"],
  [/^metric '(.+)' is not among the channels (.+) of (.+)$/, "指标「$1」不在 $3 的通道 $2 里"],
  [/^window (\d+) is not smaller than series length (\d+)$/, "窗口 $1 不小于序列长度 $2"],
];

// Longest first, so "latency p99" is not shadowed by "latency".
const SORTED_TERMS = Object.keys(TERMS).sort((a, b) => b.length - a.length);

/** Translate one backend string (channel/series/state name, label, or error message). */
export function dyn(s: string | null | undefined): string {
  if (s == null) return "";
  if (!isZh()) return s;
  const raw = s.trim();
  if (TERMS[raw]) return TERMS[raw];
  for (const [re, rep] of PREFIXES) if (re.test(raw)) return raw.replace(re, rep);
  for (const [re, rep] of ERRORS) if (re.test(raw)) return raw.replace(re, rep);
  let out = raw;
  for (const term of SORTED_TERMS) {
    if (out.includes(term)) out = out.split(term).join(TERMS[term]);
  }
  return out;
}

/** Translate a list of names and join it with the separator of the active language. */
export function dynList(items: string[], sep = ", "): string {
  return items.map(dyn).join(isZh() ? "、" : sep);
}

/** Turn a thrown value into readable text (strips the "Error: " prefix, then translates). */
export function dynError(e: unknown): string {
  return dyn(String(e).replace(/^Error:\s*/, ""));
}
