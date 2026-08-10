# LLM-DMF experiment draft schema

Submit `projectName` separately. For a bespoke project, `project` is the experiment list itself. Do not wrap that list in `{projectName, experiments}`; the application assembles the stored project after validation.

The submission also carries consistency metadata:

- `requestedExperimentCount`: the explicit total required by the conversation, or `null` when unspecified.
- `requestedTotalRuns`: the explicit sum of all repetitions required by the conversation, or `null` when unspecified.
- `requestedCategoryCounts`: explicit per-category experiment totals from the conversation, or an empty mapping when unspecified.

These values represent user requirements. Do not replace them with the number of objects that happened to be generated. The application rejects and requests correction when these totals do not match the structured project.

Return exactly one JSON object matching the supplied schema. Randomized merge matrices use its compact `mergeSeries` field: each item describes ranges and a model-authored Prompt template. The application expands these specifications after the model response. Do not also populate `project` when using `mergeSeries`.

Each experiment contains:

- `category`: short grouping label. Many independent experiments may share the same category.
- `mode`: `complete`, `default`, or `multi`.
- `repeats`: integer from 1 to 100 for rerunning this exact test case.
- `notes`: optional audit note.
- `steps`: one or more ordered step objects.

Mode constraints:

- `complete`: exactly one step.
- `default`: exactly one step.
- `multi`: at least two steps whose conversation state must be preserved.

Do not represent independent Prompt variants as steps. “10 different Prompts” requires 10 experiment objects. The application creates experiment IDs and step numbers after submission.

Each step contains:

- `prompt`: the exact user Prompt sent to LLM-DMF.
- `expectedOperation`: one or more operations separated by ` + `.
- `expectedParameters`: parameter groups separated by ` || ` when multiple operations are expected.
- `notes`: optional step note.

Supported audit operation labels:

- `挤出生成`
- `多挤出式生成`
- `移动`
- `混合`
- `阵列混合`
- `合并`
- `阵列生成`

The six user-facing methods and their real required parameters are documented in [tool-parameters.md](tool-parameters.md). `阵列生成` is a helper operation used before array move, array mix, or array merge.

Supported friendly parameter syntax includes:

- `数量=3`
- `位置=20,24`
- `方向=右`
- `尺寸=1x1`
- `距离=20`
- `圈数=3`
- `间距=8`
- `液滴组1=20,20,2,2/30,20,2,2`
- `液滴组2=26,20,2,2/36,20,2,2`

Examples:

- `挤出生成` with `数量=1；位置=20,20；方向=右；尺寸=1x1`
- `阵列生成 + 阵列生成 + 合并` with `数量=25；位置=20,20；尺寸=2x2；间距=8 || 数量=25；位置=26,20；尺寸=2x2；间距=8 ||`
- `移动` with `方向=右；距离=20；位置=20,20；尺寸=1x1`
- `混合` with `圈数=3；位置=20,20；尺寸=1x1`

When several expected operations are separated by ` + `, provide the same number of parameter groups separated by ` || `. A helper-generated workspace array may be referenced by a later operation, so its later parameter group may contain only operation-specific values or be empty.

In a multi-flow experiment, expected operations are scoped to the current conversation turn. Never repeat setup calls already completed in an earlier turn. Do not represent a whole previously created droplet group with the coordinates of only one member; either provide the full group or omit target coordinates and keep only operation-specific constraints.
