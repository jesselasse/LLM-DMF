---
name: generate-dmf-experiments
description: Generate or revise structured, auditable LLM-DMF batch experiment projects from a research goal or conversational requirements. Use when creating DMF experiment suites, test matrices, Prompt variations, expected operations, multi-flow trials, default-parameter trials, or merge/move/mix/squeeze evaluations for the LLM-DMF batch tool.
---

# Generate DMF Experiments

Create a compact experiment draft that can be validated by the LLM-DMF batch tool.

## Model the study correctly

- A project is the complete study requested by the user.
- A category is only a grouping label inside the project. It does not create conversation context.
- An experiment is one independently runnable test case.
- A step is one user message inside that experiment's conversation.
- A Prompt variation is a separate experiment unless it explicitly depends on state produced by an earlier Prompt in the same run.
- `repeats` reruns the exact same experiment. It never represents different Prompt variations.

For example, “two categories, each with 10 different Prompts” means 20 experiment objects. Each object repeats its category label and normally contains one step. It does not mean two experiments with 10 steps each.

## Workflow

Before designing coordinates, read `gridRows` and `gridCols` from the current application context. The grid has `gridRows` rows and `gridCols` columns: every rectangle must satisfy `0 <= x`, `0 <= y`, `x + w <= gridCols`, and `y + h <= gridRows`. Apply this check to every explicit droplet, source droplet, and generated array extent. Never infer the coordinate limits by reversing the displayed `rows × columns` label.

In every generated user-facing Prompt, use only these six canonical method names and forms:

- `merge`
- `挤出式生成`
- `挤出式生成 x 个液滴`, replacing `x` with the requested integer
- `x 圈混合`, replacing `x` with the requested integer
- `x 圈阵列混合`, replacing `x` with the requested integer
- `移动`

Do not substitute aliases such as `合并`, `多挤出式生成`, `混匀`, or `阵列混匀` in user-facing Prompts. The `expectedOperation` field still uses the internal audit labels defined by the schema; these canonical names constrain Prompt wording only.

1. Infer the requested project, categories, independent test cases, dependent conversation steps, variations, and repetition count.
2. Map every test case to the six user-facing methods and their real backend tool chains in [references/tool-parameters.md](references/tool-parameters.md).
3. Make every `complete` Prompt self-contained. Include every value required by the relevant tools so the production LLM-DMF backend should not need to ask a follow-up.
4. Handle missing values deliberately:
   - When the user asks the designer to choose or vary a value, generate explicit valid values and summarize the chosen range or rule.
   - When a fixed choice would materially change the study, ask one concise follow-up before creating the project.
   - When defaults are appropriate, propose their exact values and ask for confirmation before applying them.
   - Treat ambiguous text such as `22` as unresolved. Do not silently rewrite it as `2×2` unless the conversation has already established that meaning.
5. Write natural-language Prompts exactly as they should be sent to the production backend. Do not replace them with implementation instructions.
6. Provide matching expected operations and parameters for automatic audit. Use an empty expected operation only when human review is intentionally required.
7. Audit cardinality before submission: the number of independent Prompt variations must equal the number of experiment objects, category totals must match the request, and step counts must match the selected mode.
8. Populate `requestedExperimentCount`, `requestedTotalRuns`, and `requestedCategoryCounts` from the conversation's explicit requirements. These fields describe what the user requested, not what the draft happens to contain. Use `null` or an empty mapping only when the conversation did not specify the corresponding total.
9. Return exactly one JSON object matching the supplied schema. Put the project name in `projectName`. For a bespoke project, put the experiment list directly in `project`; do not wrap it in another object. For compact merge series, leave `project` empty and use `mergeSeries`.

## Generate randomized merge series compactly

When the user requests a randomized or systematically varied series of pair or multi-droplet merge experiments, do not enumerate coordinates, expected parameters, experiments, or table rows yourself.

1. Put one compact `mergeSeries` item in the single submission for each requested category or parameter regime.
2. Supply every range explicitly, including grid size, seed, size range, gap range, pair-count range, axes policy, experiment count, and repeats.
3. You author `promptTemplate`, so the user-facing Prompt wording remains model-generated. Use exactly these placeholders:
   - Pair merge: `{droplet1}` and `{droplet2}`.
   - Multi-droplet merge: `{count}`, `{group1}`, and `{group2}`.
4. The application deterministically generates coordinates, fills the Prompt template, derives expected parameters, and validates merge geometry.
5. In that same submission, provide `projectName`, a concise `assistantReply`, and the requirement totals. Leave `project` empty and never copy expanded experiments into the response.
6. Keep `assistantReply` to a short summary of the ranges and cardinality. Do not restate generated Prompt rows.

Use the direct `project` field only for bespoke experiments that cannot be expressed by the compact merge-series format.

## Choose the mode

- `complete`: exactly one self-contained step with all required operation parameters.
- `default`: exactly one intentionally incomplete step used to test the production model's clarification behavior. Do not fill its missing values in the test Prompt.
- `multi`: two or more ordered steps in one conversation. Use it only when a later Prompt refers to droplets, state, or results created by an earlier Prompt in the same run.

For `multi`, each step's expected operations describe only the tools that should be called for that user message. Do not repeat array-generation or squeeze calls from earlier turns when the later Prompt operates on the existing conversation state. If a later operation targets a previously created droplet group, include the complete group only when it is known; otherwise provide operation-specific parameters such as direction, distance, or turns and leave target coordinates out for human review.

Multiple operations requested in one self-contained Prompt are still one `complete` step. For example, generating two arrays and then merging them can be a single complete experiment with the expected tool chain `阵列生成 + 阵列生成 + 合并`.

## Output boundaries

- Do not create experiment IDs or step numbers. The application assigns them deterministically.
- Do not invent raw activation sequences, TXT output, GIF output, pass/fail results, or model replies.
- Do not claim an experiment passed before it runs.
- Never combine independent Prompt variations into the steps of one experiment.
- Keep multiple ordered steps in one experiment only when conversation context must be preserved.
- Use a default-information experiment only when the model should ask for missing values. Never mix default-information and multi-flow behavior in one experiment.
- Treat coordinates in squeeze and array generation as source locations, not guaranteed final droplet positions.
