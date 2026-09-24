# Jev / Nano / Sonnet: paired comparison

Generated 2026-09-21T07:49:36.814Z. Policy frozen before the comparative run: Jev minimum field confidence < 0.8; Nano confidence < 0.7; P0/P1 or needs_human routes to Sonnet.

**Historical paired replay on previously examined synthetic data, not a new holdout result.**

| Strategy | Category | Joint category + priority + human | P0/P1 recall | Final human recall | Preserved review recall | False review flags | Calls J/N/S | Estimated market USD | Estimated p50/p95 ms |
|---|---|---|---|---|---|---|---|---|---|
| sonnet | 94.0% (141/150) | 83.3% (125/150) | 100.0% (7/7) | 40.9% (9/22) | 40.9% (9/22) | 0/128 | 0/0/150 | 1.241988 | 3362/5036 |
| nano | 82.0% (123/150) | 74.0% (111/150) | 100.0% (7/7) | 54.5% (12/22) | 54.5% (12/22) | 0/128 | 0/150/0 | 0.015726 | 674/875 |
| jev | 94.7% (142/150) | 90.0% (135/150) | 100.0% (7/7) | 77.3% (17/22) | 77.3% (17/22) | 0/128 | 150/0/0 | incomplete | 7124/7288 |
| nano-sonnet | 84.0% (126/150) | 72.7% (109/150) | 100.0% (7/7) | 31.8% (7/22) | 54.5% (12/22) | 0/128 | 0/150/12 | 0.118317 | 684/4427 |
| jev-sonnet | 100.0% (150/150) | 90.0% (135/150) | 100.0% (7/7) | 40.9% (9/22) | 77.3% (17/22) | 0/128 | 150/0/31 | incomplete | 7129/11268 |
| jev-nano-sonnet | 100.0% (150/150) | 90.0% (135/150) | 100.0% (7/7) | 40.9% (9/22) | 77.3% (17/22) | 0/128 | 150/14/17 | incomplete | 7129/11268 |

## Does the middle tier help?

Jev deferred 14 non-high-risk tickets to Nano. Nano retained 14, avoiding that many Sonnet calls.
On that deferred subset, Nano got 9 joint labels right and Sonnet got 9.
Retained Nano wrong / Sonnet right: none.
Retained Nano right / Sonnet wrong: none.

## Provenance and limitations

- Not an untouched holdout or production benchmark; 150 reviewed synthetic tickets span 11 scenario families.
- Jev runs now; Bedrock results are historical. Summed cached latency is an estimate, not live end-to-end latency.
- Identical tickets and rubric, but provider-specific question/prompt formats differ. No model receives an earlier model's answer.
- Jev confidence and Nano self-reported confidence are not calibrated correctness probabilities or directly comparable scales.
- Jev alias does not pin an underlying provider version. Zero gateway-reported charges do not imply free market pricing.
- The final model's needs_human label and an OR of review signals are reported separately; false positives are also counted.
- Cost estimates use recorded usage/pricing and exclude hosting, human review, and potentially unreported retries.
- Nano baseline: 2026-08-31T07:25:23.012Z; Sonnet baseline: 2026-08-31T07:25:23.012Z.
- Jev market cost across all tickets: $0.010859; gateway-reported charge: $0.000000.
- JSON companion contains individual synthetic-ticket decisions, labels, routing, hashes, pricing, and timestamps. No credentials.

## Collection notes

**The batch latency figures include collector queueing and must not be used to compare model speed.**

The Chinese [findings](three-tier-findings.zh-CN.md) reconstruct successful-call market cost estimates separately from unknown retry/failure charges.

- 本次前 59 条 Jev 成功结果来自未生效限速的两次采集；后 91 条通过每次至少间隔 2.4 秒的限速入口收集。批量 Jev 延迟混合了两种采集方式，且包含排队，不能用于模型速度比较。
- 批量缓存记录 150 个成功结果、其中 4 个结果记录了第二次尝试；另有两次中断采集中的 HTTP 429 失败尝试，未计入缓存 total_attempts。总账单费用不能据此完全重建。
- 150 个成功 Jev 结果报告的 Gateway cost 合计为 0；marketCost 合计约 $0.010859。零 Gateway charge 不意味着市场定价免费。
- 另通过真正的 MCP 客户端运行了 3 张工单，观察到 Jev、Jev→Nano、Jev→Sonnet 三条路径。它们是连接和路由验证，不是新的准确率测试集；原始结果见 three-tier-live-smoke.json。
