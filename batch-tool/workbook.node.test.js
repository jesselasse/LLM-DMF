const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const {
  createInputWorkbookBuffer,
  createTemplateBuffer,
  parseWorkbookBuffer,
} = require("./workbook");

test("template workbook describes complete, default, and multi-flow experiments", async () => {
  const buffer = await createTemplateBuffer();
  const suite = await parseWorkbookBuffer(buffer);

  assert.equal(suite.format, "llm-dmf-batch-input-v2");
  assert.equal(suite.config.defaultFollowupReply, "请使用默认参数并生成");
  assert.deepEqual(
    suite.experiments.map((experiment) => [experiment.id, experiment.type, experiment.steps.length]),
    [
      ["E001", "完整", 1],
      ["E002", "缺省", 1],
      ["E003", "多流程", 3],
    ]
  );
  assert.equal(suite.totalRuns, 11);
  assert.equal(suite.editorRows.length, 5);
  assert.deepEqual(suite.experiments[0].steps[0].expectedCalls, [
    {
      tool: "squeeze",
      args: { count: 1, x: 20, y: 20, direction: "right", w: 1, h: 1, size: "1x1" },
    },
  ]);
});

test("visual editor rows use the same workbook parser as uploaded files", async () => {
  const rows = [{
    enabled: true,
    category: "合并",
    id: "M001",
    type: "完整",
    repeats: 2,
    order: 1,
    prompt: "将两个液滴合并",
    expectedOperation: "合并",
    expectedParameters: "液滴组1=20,20,2,2；液滴组2=26,20,2,2",
    notes: "编辑器测试",
  }];
  const suite = await parseWorkbookBuffer(
    await createInputWorkbookBuffer(rows, { title: "可视化编辑测试" })
  );
  assert.equal(suite.config.experimentName, "可视化编辑测试");
  assert.equal(suite.totalRuns, 2);
  assert.equal(suite.experiments[0].steps[0].expectedCalls[0].tool, "merge");
  assert.deepEqual(suite.editorRows[0], rows[0]);
});

test("multi-flow experiments require at least two ordered prompts", async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createTemplateBuffer());
  workbook.getWorksheet("实验").getRow(5).values = [];
  workbook.getWorksheet("实验").getRow(6).values = [];
  await assert.rejects(
    parseWorkbookBuffer(await workbook.xlsx.writeBuffer()),
    /至少需要 2 个 Prompt/
  );
});

test("merge experiments support plain-language droplet groups and per-call parameters", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("实验");
  sheet.addRow(["启用", "大项", "实验编号", "类型", "重复次数", "步骤", "Prompt", "预期操作", "预期参数", "备注"]);
  sheet.addRow([
    "是", "双液滴合并", "M001", "完整", 1, 1,
    "将位于（20，20）的 2×2 液滴与位于（26，20）的 2×2 液滴合并",
    "合并",
    "液滴组1=20,20,2,2；液滴组2=26,20,2,2",
    "",
  ]);
  sheet.addRow([
    "是", "多液滴合并", "M002", "完整", 1, 1,
    "生成两组阵列并逐对合并",
    "阵列生成 + 阵列生成 + 合并",
    "数量=25；位置=20,20；尺寸=2x2；间距=8 || 数量=25；位置=26,20；尺寸=2x2；间距=8 ||",
    "",
  ]);
  const suite = await parseWorkbookBuffer(await workbook.xlsx.writeBuffer());
  assert.deepEqual(suite.experiments[0].steps[0].expectedCalls[0].args, {
    droplets1: [{ x: 20, y: 20, w: 2, h: 2 }],
    droplets2: [{ x: 26, y: 20, w: 2, h: 2 }],
  });
  assert.deepEqual(suite.experiments[1].steps[0].expectedCalls, [
    { tool: "generate_array", args: { count: 25, x: 20, y: 20, w: 2, h: 2, size: "2x2", gap: 8 } },
    { tool: "generate_array", args: { count: 25, x: 26, y: 20, w: 2, h: 2, size: "2x2", gap: 8 } },
    { tool: "merge", args: {} },
  ]);
});

test("experiment validation rejects out-of-grid expected droplets", async () => {
  const rows = [{
    enabled: true,
    category: "合并",
    id: "M001",
    type: "完整",
    repeats: 1,
    order: 1,
    prompt: "合并两个液滴",
    expectedOperation: "合并",
    expectedParameters: "液滴组1=138,20,3,3；液滴组2=120,20,2,2",
    notes: "",
  }];
  await assert.rejects(
    parseWorkbookBuffer(await createInputWorkbookBuffer(rows)),
    /超出 120×140 网格/
  );
});

test("experiment validation rejects incompatible merge pairs", async () => {
  const rows = [{
    enabled: true,
    category: "合并",
    id: "M001",
    type: "完整",
    repeats: 1,
    order: 1,
    prompt: "合并两个液滴",
    expectedOperation: "合并",
    expectedParameters: "液滴组1=20,20,2,2；液滴组2=30,30,2,2",
    notes: "",
  }];
  await assert.rejects(
    parseWorkbookBuffer(await createInputWorkbookBuffer(rows)),
    /不满足单轴投影重叠、另一轴分离/
  );
});
