import unittest
from ai_experiment_designer import (
    DesignerResponse,
    MergeSeriesRequest,
    build_merge_series,
    materialize_designer_response,
    parse_json_object,
    validate_project_structure,
)


def step(prompt="test"):
    return {"prompt": prompt}


class ProjectStructureTests(unittest.TestCase):
    def test_plain_json_output_accepts_code_fences_without_tool_calls(self):
        parsed = parse_json_object(
            '```json\n{"assistantReply":"已生成","needsInput":true}\n```'
        )
        self.assertEqual(parsed["assistantReply"], "已生成")

    def test_plain_json_output_rejects_non_object_values(self):
        with self.assertRaisesRegex(ValueError, "one JSON object"):
            parse_json_object("[]")

    def test_designer_accepts_experiment_list_without_redundant_project_wrapper(self):
        response = DesignerResponse(
            assistantReply="已生成",
            needsInput=False,
            projectName="多流程测试",
            project=[
                {
                    "category": "2 步链",
                    "mode": "multi",
                    "repeats": 1,
                    "steps": [step("第一步"), step("第二步")],
                }
            ],
        )
        self.assertEqual(response.projectName, "多流程测试")
        self.assertEqual(len(response.project or []), 1)

    def test_complete_prompt_variations_must_be_separate_experiments(self):
        with self.assertRaisesRegex(ValueError, "separate experiments"):
            validate_project_structure(
                {
                    "experiments": [
                        {"mode": "complete", "steps": [step(str(i)) for i in range(10)]}
                    ]
                }
            )

    def test_default_experiment_has_one_initial_prompt(self):
        with self.assertRaisesRegex(ValueError, "exactly 1 step"):
            validate_project_structure(
                {"experiments": [{"mode": "default", "steps": [step(), step()]}]}
            )

    def test_multi_experiment_preserves_dependent_steps(self):
        validate_project_structure(
            {"experiments": [{"mode": "multi", "steps": [step(), step()]}]}
        )

    def test_twenty_independent_complete_prompts_are_valid(self):
        validate_project_structure(
            {
                "experiments": [
                    {"mode": "complete", "steps": [step(str(i))]}
                    for i in range(20)
                ]
            }
        )

    def test_materialized_response_keeps_the_existing_project_shape(self):
        result = materialize_designer_response(
            {
                "assistantReply": "已生成",
                "needsInput": False,
                "projectName": "多流程测试",
                "project": [
                    {
                        "category": "流程",
                        "mode": "multi",
                        "repeats": 2,
                        "steps": [step("第一步"), step("第二步")],
                    }
                ],
                "requestedExperimentCount": 1,
                "requestedTotalRuns": 2,
                "requestedCategoryCounts": {"流程": 1},
            }
        )
        self.assertEqual(result["project"]["projectName"], "多流程测试")
        self.assertEqual(len(result["project"]["experiments"]), 1)
        self.assertNotIn("requestedExperimentCount", result)


class MergeSeriesTests(unittest.TestCase):
    def request(self, **overrides):
        values = {
            "category": "双液滴合并",
            "experimentCount": 10,
            "repeats": 3,
            "mergeKind": "pair",
            "gridRows": 120,
            "gridCols": 140,
            "seed": "20260808-pair",
            "sizeMin": 1,
            "sizeMax": 3,
            "gapMin": 4,
            "gapMax": 8,
            "pairsMin": 1,
            "pairsMax": 1,
            "axes": "balanced",
            "promptTemplate": "请将{droplet1}与{droplet2}合并。",
            "notes": "测试",
        }
        values.update(overrides)
        return MergeSeriesRequest(**values)

    def test_pair_series_is_deterministic_and_complete(self):
        request = self.request()
        first = build_merge_series(request)
        second = build_merge_series(request)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 10)
        self.assertEqual(sum(item["repeats"] for item in first), 30)
        self.assertTrue(all(item["steps"][0]["prompt"] for item in first))
        self.assertTrue(
            all(item["steps"][0]["expectedOperation"] == "合并" for item in first)
        )

    def test_multi_series_expands_compact_ranges(self):
        experiments = build_merge_series(
            self.request(
                category="多液滴合并",
                mergeKind="multi",
                seed="20260808-multi",
                pairsMin=10,
                pairsMax=30,
                promptTemplate=(
                    "请将以下两组各{count}个液滴逐对合并。"
                    "第一组：{group1}。第二组：{group2}。"
                ),
            )
        )
        self.assertEqual(len(experiments), 10)
        for experiment in experiments:
            prompt = experiment["steps"][0]["prompt"]
            parameters = experiment["steps"][0]["expectedParameters"]
            self.assertNotIn("{", prompt)
            first_group, second_group = parameters.split("；")
            self.assertEqual(first_group.count("/") , second_group.count("/"))

    def test_prompt_wording_remains_model_supplied(self):
        experiments = build_merge_series(
            self.request(promptTemplate="MODEL PREFIX {droplet1} THEN {droplet2} MODEL SUFFIX")
        )
        prompt = experiments[0]["steps"][0]["prompt"]
        self.assertTrue(prompt.startswith("MODEL PREFIX "))
        self.assertTrue(prompt.endswith(" MODEL SUFFIX"))

    def test_unsupported_placeholder_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported placeholder"):
            build_merge_series(
                self.request(
                    promptTemplate="请将{droplet1}与{droplet2}合并，{unknown}。"
                )
            )


if __name__ == "__main__":
    unittest.main()
