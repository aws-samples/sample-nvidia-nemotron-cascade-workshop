import { existsSync, readFileSync, writeFileSync } from "node:fs";
const base = "docs/research";
const report = JSON.parse(readFileSync(`${base}/three-tier-comparison.json`, "utf8"));
const noteFile = `${base}/three-tier-run-notes.json`;
const candidate = existsSync(noteFile) ? JSON.parse(readFileSync(noteFile, "utf8")) : null;
const notes = candidate?.jev_records_sha256 === report.jev_run.records_sha256 ? candidate : null;
function successfulCost(stage) {
  const value = stage.estimated_market_cost_usd;
  if (value === null || !Number.isFinite(value) || value < 0) {
    throw new Error("A successful stage has unknown cost; cannot reconstruct this cost table.");
  }
  return value;
}
const costs = Object.fromEntries(report.summaries.map(({ strategy }) => [
  strategy,
  report.records.reduce((sum, row) => sum + row.strategies[strategy].calls.reduce(
    (subtotal, name) => subtotal + successfulCost(row.stages[name]), 0,
  ), 0),
]));
const pct = (n, d) => `${(100 * n / d).toFixed(1)}%（${n}/${d}）`;
const names = {
  sonnet: "仅 Sonnet", nano: "仅 Nano", jev: "仅 Jev",
  "nano-sonnet": "Nano → Sonnet", "jev-sonnet": "Jev → Sonnet",
  "jev-nano-sonnet": "Jev → Nano → Sonnet",
};
const three = report.summaries.find((s) => s.strategy === "jev-nano-sonnet");
const two = report.summaries.find((s) => s.strategy === "jev-sonnet");
const original = report.summaries.find((s) => s.strategy === "nano-sonnet");
const missed = report.records.filter((r) => r.label.intended_needs_human && !r.strategies["jev-nano-sonnet"].review_required);
const routes = Object.entries(three.routes).map(([route, count]) => `${route}：${count}`).join("；");
const savings = 100 * (1 - costs["jev-nano-sonnet"] / costs["jev-sonnet"]);
const premium = 100 * (costs["jev-nano-sonnet"] / costs["nano-sonnet"] - 1);
const slack = report.records.find((r) => r.ticket_id === "P-0053");
const ambiguous = report.records.find((r) => r.ticket_id === "P-0075");
const lines = [
  "# 三层路由示例：实测对比与含义", "",
  `报告生成于 ${report.generated_at}。原始数据见 [完整对比 JSON](three-tier-comparison.json)，方法见 [示例说明](../three-tier-example.md)。`, "",
  "这是同一批 150 张已审核合成工单的配对回放。Jev 是本次新调用；Nano、Sonnet 使用 2026-08-31 的已验证缓存。数据只有 11 个场景家族，且此前已被查看；不能把结果当作全新测试集或生产准确率。", "",
  "| 方案 | 分类匹配率 | 三项标签全部匹配 | 保留人工复核信号后的召回率 | Sonnet 调用 | 成功调用的市场成本估算（150 张） |",
  "|---|---|---|---|---:|---:|",
  ...report.summaries.map((s) => `| ${names[s.strategy]} | ${pct(s.category_correct, s.n)} | ${pct(s.joint_correct, s.n)} | ${pct(s.review_required_recalled, s.human_total)} | ${s.calls.sonnet} | $${costs[s.strategy].toFixed(6)} |`),
  "",
  "“三项标签”指类别、优先级和**最后一个模型**的 needs_human，必须同时匹配。人工复核召回率则使用独立的 review_required 字段：任何一层曾经要求人工处理，都保留该信号。两种指标不能混在一起。",
  "",
  "费用列按实际成功返回的用量/市场报价累加，不含未知失败或重试费用、托管费、人工处理费，也不代表账单。原始报告在费用完整性不足时保留 null，而不把未知部分记成零。",
  "",
  "## Nano 这一层有什么价值？", "",
  `本次 Jev 有 ${report.middle_layer.jev_uncertain_non_high_risk} 张非高风险工单不够确定。Nano 接住了其中 ${report.middle_layer.nano_retained} 张，Sonnet 从两层方案的 ${two.calls.sonnet} 次降到 ${three.calls.sonnet} 次。`,
  `与 Jev → Sonnet 比，三层成功调用成本估算降低 ${savings.toFixed(1)}%；类别及完整标签匹配数${three.category_correct === two.category_correct && three.joint_correct === two.joint_correct ? "相同" : "不同"}。`,
  `这 ${report.middle_layer.nano_retained} 张中，Nano 错而 Sonnet 对的完整标签案例有 ${report.middle_layer.retained_nano_wrong_sonnet_right.length} 张；Nano 对而 Sonnet 错的有 ${report.middle_layer.retained_nano_right_sonnet_wrong.length} 张。`,
  `与原来的 Nano → Sonnet 比，成本估算增加 ${premium.toFixed(1)}%，类别匹配从 ${original.category_correct}/${original.n} 变为 ${three.category_correct}/${three.n}。这不是所有指标都更好的替代方案。`,
  "",
  `实际回放路径：${routes}。这批工单${three.routes["jev→nano→sonnet"] ? `有 ${three.routes["jev→nano→sonnet"]} 张走满三层` : "没有走满 Jev→Nano→Sonnet 的工单"}；“两层都不确定后进入 Sonnet”的分支另有单元测试覆盖。`,
  "",
  "## 一个具体例子", "",
  ...(slack ? [
    `P-0053 是重新连接 Slack 的问题。Jev 选择 ${slack.stages.jev.decision.category}，最低字段置信度 ${slack.stages.jev.decision.confidence}；三层路由为 ${slack.strategies["jev-nano-sonnet"].route}，最终类别 ${slack.strategies["jev-nano-sonnet"].decision.category}，参考类别 ${slack.label.intended_category}。`,
  ] : []),
  "",
  ...(ambiguous ? [
    `P-0075 是不确定保存的筛选器消失是否属于预期行为的问题。参考 needs_human=${ambiguous.label.intended_needs_human}；Jev / Nano / Sonnet 的判断分别为 ${["jev", "nano", "sonnet"].map((s) => ambiguous.stages[s].decision.needs_human).join(" / ")}。增加模型层数无法自动消除共同盲点。`,
  ] : []),
  "",
  "## 需要保留的限制", "",
  `- 三层仍漏掉 ${missed.length} 张需要人工复核的工单：${missed.map((r) => r.ticket_id).join("、") || "无"}。`,
  `- 最后一个模型只找回 ${three.final_model_human_recalled}/${three.human_total} 张人工复核需求；保留前面各层信号后为 ${three.review_required_recalled}/${three.human_total}。调用方应使用 review_required 做人工交接。`,
  `- 保留信号后，${three.non_human_total} 张无需人工的工单中有 ${three.review_required_false_positives} 张被误报；这个小样本不能证明今后不会误报。`,
  "- 多条工单来自同一个场景模板，不是 150 个完全独立的现实案例。类别 100% 只描述这批样本。",
  "- 阈值在比较前固定：Jev 最低字段置信度 0.8；Nano 0.7。没有根据这批结果回调阈值。",
  "- Jev 的统计置信度与 Nano 的自报置信度都不是已校准的正确概率。下一步应在新数据上验证，而不是凭本次结果宣称通用优势。",
  ...(notes ? notes.measurement_notes.map((note) => `- ${note}`) : [
    "- 若使用限速采集命令，Jev latencyMs 包含排队等待；不能拿批量 p50/p95 推断纯模型速度。",
  ]),
  "",
  "## 如何复算费用列", "",
  "每条工单先取 strategies[方案].calls，再累加相应 stages[模型].estimated_market_cost_usd；最后对全部工单求和。运行 `node scripts/summarize-three-tier.mjs` 可从原始 JSON 重建本报告。",
  "",
];
writeFileSync(`${base}/three-tier-findings.zh-CN.md`, lines.join("\n"));
report.interpretation = {
  successful_call_market_cost_estimates_usd: costs,
  excludes_unknown_failed_attempt_costs: true,
  collection_notes: notes?.measurement_notes ?? [
    "Rate-limited collection includes queueing in Jev latency; do not treat it as pure model latency.",
  ],
};
writeFileSync(`${base}/three-tier-comparison.json`, `${JSON.stringify(report, null, 2)}\n`);
const comparisonMd = readFileSync(`${base}/three-tier-comparison.md`, "utf8").split("\n## Collection notes")[0];
writeFileSync(`${base}/three-tier-comparison.md`, `${comparisonMd}\n## Collection notes\n\n` +
  "**The batch latency figures include collector queueing and must not be used to compare model speed.**\n\n" +
  "The Chinese [findings](three-tier-findings.zh-CN.md) reconstruct successful-call market cost estimates separately from unknown retry/failure charges.\n\n" +
  report.interpretation.collection_notes.map((note) => `- ${note}`).join("\n") + "\n");
console.log(`Wrote ${base}/three-tier-findings.zh-CN.md`);
