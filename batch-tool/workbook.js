const ExcelJS = require("exceljs");

const EXPERIMENT_TYPES = new Set(["完整", "缺省", "多流程"]);
const INPUT_HEADERS = [
  "启用", "大项", "实验编号", "类型", "重复次数",
  "步骤", "Prompt", "预期操作", "预期参数", "备注",
];

const TEMPLATE_ROWS = [
  [
    "是", "完整实验", "E001", "完整", 5, 1,
    "在（20，20）向右挤出式生成 1 个尺寸为 1×1 的液滴",
    "挤出生成", "数量=1；位置=20,20；方向=右；尺寸=1x1", "完整信息示例",
  ],
  [
    "是", "缺省实验", "E002", "缺省", 3, 1,
    "在（40，90）向上挤出式生成 1 个液滴",
    "挤出生成", "数量=1；位置=40,90；方向=上", "缺少尺寸时允许模型追问",
  ],
  [
    "是", "组合实验", "E003", "多流程", 3, 1,
    "在（20，24）向右挤出生成 3 个尺寸为 1×1 的液滴",
    "挤出生成", "数量=3；位置=20,24；方向=右；尺寸=1x1", "多流程第 1 步",
  ],
  [
    "是", "组合实验", "E003", "多流程", 3, 2,
    "对刚才生成的液滴做 3 圈阵列混匀",
    "阵列混匀", "圈数=3", "直接使用上一步真实生成的液滴",
  ],
  [
    "是", "组合实验", "E003", "多流程", 3, 3,
    "将这些液滴向下移动 10 格",
    "移动", "方向=下；距离=10", "多流程第 3 步",
  ],
];

function cellValue(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text || "").join("").trim();
    }
    if (value.text !== undefined) return String(value.text).trim();
    if (value.result !== undefined) return String(value.result).trim();
  }
  return String(value).trim();
}

function integer(value, fallback, field, { min = 0, max = 10000 } = {}) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return parsed;
}

function booleanValue(value, fallback = true) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["是", "true", "1", "yes", "y"].includes(text)) return true;
  if (["否", "false", "0", "no", "n"].includes(text)) return false;
  throw new Error(`无法识别是否启用：${value}`);
}

function jsonValue(value, fallback, field) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${field} 不是有效 JSON：${error.message}`);
  }
}

function rowsByHeader(worksheet) {
  if (!worksheet) return [];
  const headers = new Map();
  worksheet.getRow(1).eachCell((cell, column) => {
    const name = cellValue(cell);
    if (name) headers.set(name, column);
  });
  const rows = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const record = { __row: rowNumber };
    headers.forEach((column, name) => {
      record[name] = cellValue(row.getCell(column));
    });
    rows.push(record);
  }
  return rows;
}

function parseConfig(worksheet) {
  const values = {};
  rowsByHeader(worksheet).forEach((row) => {
    const key = row["字段"];
    if (key) values[key] = row["值"];
  });
  return {
    experimentName: values["实验名称"] || "批量测试",
    defaultRepeats: integer(values["默认重复次数"], 1, "默认重复次数", {
      min: 1,
      max: 100,
    }),
    concurrency: integer(values["并发数"], 1, "并发数", { min: 1, max: 10 }),
    timeoutSeconds: integer(values["超时时间（秒）"], 240, "超时时间", {
      min: 5,
      max: 1800,
    }),
    defaultFollowupReply:
      values["默认追问回答"] || "请使用默认参数并生成",
    maxFollowups: integer(values["最大追问次数"], 3, "最大追问次数", {
      min: 0,
      max: 20,
    }),
    rows: integer(values["网格行数"], 120, "网格行数", { min: 1, max: 1000 }),
    cols: integer(values["网格列数"], 140, "网格列数", { min: 1, max: 1000 }),
    configLabel: values["配置名称"] || "当前配置",
  };
}

function parseExperiments(worksheet, config) {
  return rowsByHeader(worksheet).map((row) => {
    const id = String(row["实验编号"] || "").trim();
    if (!id) throw new Error(`实验表第 ${row.__row} 行缺少实验编号`);
    const type = String(row["实验类型"] || "完整").trim();
    if (!EXPERIMENT_TYPES.has(type)) {
      throw new Error(`实验 ${id} 的实验类型必须是完整、缺省或多流程`);
    }
    const selectedDroplets = jsonValue(
      row["初始已选液滴 JSON"],
      [],
      `实验 ${id} 的初始已选液滴`
    );
    if (!Array.isArray(selectedDroplets)) {
      throw new Error(`实验 ${id} 的初始已选液滴必须是数组`);
    }
    return {
      enabled: booleanValue(row["是否启用"], true),
      category: String(row["大项"] || "").trim(),
      id,
      type,
      repeats: integer(row["重复次数"], config.defaultRepeats, `实验 ${id} 的重复次数`, {
        min: 1,
        max: 100,
      }),
      maxFollowups: integer(
        row["最大追问次数"],
        config.maxFollowups,
        `实验 ${id} 的最大追问次数`,
        { min: 0, max: 20 }
      ),
      initialStepsText: String(row["初始步骤 TXT"] || "").trim(),
      selectedDroplets,
      notes: String(row["备注"] || "").trim(),
      steps: [],
    };
  });
}

function parseExpectedCalls(row, experimentId, stepOrder) {
  const combined = jsonValue(
    row["预期工具调用 JSON"],
    null,
    `实验 ${experimentId} 第 ${stepOrder} 步的预期工具调用`
  );
  if (combined !== null) {
    const calls = Array.isArray(combined) ? combined : [combined];
    calls.forEach((call, index) => {
      if (!call || typeof call !== "object" || Array.isArray(call) || !call.tool) {
        throw new Error(
          `实验 ${experimentId} 第 ${stepOrder} 步的预期工具调用 ${index + 1} 无效`
        );
      }
    });
    return calls;
  }
  const tool = String(row["预期工具"] || "").trim();
  if (!tool) return [];
  const args = jsonValue(
    row["预期参数 JSON"],
    {},
    `实验 ${experimentId} 第 ${stepOrder} 步的预期参数`
  );
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`实验 ${experimentId} 第 ${stepOrder} 步的预期参数必须是对象`);
  }
  return [{ tool, args }];
}

const FRIENDLY_TOOL_NAMES = new Map([
  ["挤出生成", "squeeze"],
  ["挤出分配", "squeeze"],
  ["挤出式生成", "squeeze"],
  ["多挤出式生成", "squeeze"],
  ["移动", "move"],
  ["混合", "rotate_mix"],
  ["混匀", "rotate_mix"],
  ["阵列混合", "rotate_mix"],
  ["旋转混匀", "rotate_mix"],
  ["阵列混匀", "rotate_mix"],
  ["合并", "merge"],
  ["阵列生成", "generate_array"],
  ["squeeze", "squeeze"],
  ["move", "move"],
  ["rotate_mix", "rotate_mix"],
  ["merge", "merge"],
  ["generate_array", "generate_array"],
]);

const FRIENDLY_ARG_NAMES = new Map([
  ["数量", "count"],
  ["count", "count"],
  ["x", "x"],
  ["y", "y"],
  ["宽", "w"],
  ["w", "w"],
  ["高", "h"],
  ["h", "h"],
  ["方向", "direction"],
  ["direction", "direction"],
  ["距离", "t"],
  ["步数", "t"],
  ["t", "t"],
  ["圈数", "duration"],
  ["duration", "duration"],
  ["间距", "gap"],
  ["gap", "gap"],
]);

function normalizedDirection(value) {
  const text = String(value || "").trim().toLowerCase();
  return {
    上: "up",
    下: "down",
    左: "left",
    右: "right",
    north: "up",
    south: "down",
    west: "left",
    east: "right",
  }[text] || text;
}

function pairValue(value, field) {
  const parts = String(value || "")
    .trim()
    .replace(/[（）()]/g, "")
    .split(/[,，x×*]/)
    .map((part) => Number(part.trim()));
  if (parts.length !== 2 || !parts.every(Number.isInteger)) {
    throw new Error(`${field} 应写成 20,24 或 1x1`);
  }
  return parts;
}

function rectListValue(value, field) {
  const rects = String(value || "")
    .trim()
    .split(/[|/]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const values = part
        .replace(/[（）()]/g, "")
        .split(/[,，]/)
        .map((item) => Number(item.trim()));
      if (values.length !== 4 || !values.every(Number.isInteger) || values[2] <= 0 || values[3] <= 0) {
        throw new Error(`${field} 应写成 20,20,2,2；多液滴之间用 / 分隔`);
      }
      return { x: values[0], y: values[1], w: values[2], h: values[3] };
    });
  if (!rects.length) throw new Error(`${field} 不能为空`);
  return rects;
}

function parseFriendlyArgs(value, experimentId, stepOrder) {
  const text = String(value || "").trim();
  if (!text) return {};
  if (text.startsWith("{")) {
    return jsonValue(text, {}, `实验 ${experimentId} 第 ${stepOrder} 步的预期参数`);
  }
  const args = {};
  text.split(/[;；\n]+/).map((part) => part.trim()).filter(Boolean).forEach((part) => {
    const separator = part.search(/[=：:]/);
    if (separator < 1) {
      throw new Error(`实验 ${experimentId} 第 ${stepOrder} 步的预期参数“${part}”缺少等号`);
    }
    const label = part.slice(0, separator).trim().toLowerCase();
    const raw = part.slice(separator + 1).trim();
    if (["位置", "坐标", "position"].includes(label)) {
      [args.x, args.y] = pairValue(raw, "位置");
      return;
    }
    if (["尺寸", "size"].includes(label)) {
      const [w, h] = pairValue(raw, "尺寸");
      args.w = w;
      args.h = h;
      args.size = `${w}x${h}`;
      return;
    }
    if (["液滴组1", "液滴1", "droplets1"].includes(label)) {
      args.droplets1 = rectListValue(raw, "液滴组1");
      return;
    }
    if (["液滴组2", "液滴2", "droplets2"].includes(label)) {
      args.droplets2 = rectListValue(raw, "液滴组2");
      return;
    }
    const key = FRIENDLY_ARG_NAMES.get(label);
    if (!key) {
      throw new Error(`实验 ${experimentId} 第 ${stepOrder} 步不认识预期参数“${label}”`);
    }
    if (key === "direction") {
      args.direction = normalizedDirection(raw);
      return;
    }
    const number = Number(raw);
    if (!Number.isInteger(number)) {
      throw new Error(`实验 ${experimentId} 第 ${stepOrder} 步的“${label}”必须是整数`);
    }
    args[key] = number;
  });
  return args;
}

function parseFriendlyExpectedCalls(row, experimentId, stepOrder) {
  const text = String(row["预期操作"] || "").trim();
  if (!text || text === "不判定") return [];
  const names = text.split(/\s*\+\s*/).filter(Boolean);
  const tools = names.map((name) => {
    const tool = FRIENDLY_TOOL_NAMES.get(name.trim().toLowerCase());
    if (!tool) throw new Error(`实验 ${experimentId} 第 ${stepOrder} 步不认识预期操作“${name}”`);
    return tool;
  });
  const rawArgs = String(row["预期参数"] || "").trim();
  if (tools.length === 1) {
    return [{ tool: tools[0], args: parseFriendlyArgs(rawArgs, experimentId, stepOrder) }];
  }
  if (!rawArgs) return tools.map((tool) => ({ tool, args: {} }));
  const groups = rawArgs.split(/\s*\|\|\s*/);
  if (groups.length !== tools.length) {
    throw new Error(
      `实验 ${experimentId} 第 ${stepOrder} 步有 ${tools.length} 个预期操作，预期参数也需要用 || 分成 ${tools.length} 组`
    );
  }
  return tools.map((tool, index) => ({
    tool,
    args: parseFriendlyArgs(groups[index], experimentId, stepOrder),
  }));
}

function validateExperimentSteps(experiments) {
  experiments.forEach((experiment) => {
    experiment.steps.sort((a, b) => a.order - b.order);
    if (!experiment.steps.length) throw new Error(`实验 ${experiment.id} 没有对话步骤`);
    experiment.steps.forEach((step, index) => {
      if (step.order !== index + 1) {
        throw new Error(`实验 ${experiment.id} 的步骤序号必须从 1 连续排列`);
      }
    });
    if (experiment.type === "多流程" && experiment.steps.length < 2) {
      throw new Error(`多流程实验 ${experiment.id} 至少需要 2 个 Prompt`);
    }
    if (experiment.type !== "多流程" && experiment.steps.length !== 1) {
      throw new Error(`${experiment.type}实验 ${experiment.id} 只能包含 1 个 Prompt`);
    }
  });
}

function validateExpectedCalls(experiments, config) {
  const validateRect = (rect, label) => {
    if (!rect || typeof rect !== "object") return;
    const { x, y, w, h } = rect;
    if (![x, y, w, h].every(Number.isInteger)) return;
    if (w <= 0 || h <= 0) throw new Error(`${label} 的尺寸必须大于 0`);
    if (x < 0 || y < 0 || x + w > config.cols || y + h > config.rows) {
      throw new Error(
        `${label} 的液滴 (${x},${y},${w},${h}) 超出 ${config.rows}×${config.cols} 网格`
      );
    }
  };
  const canMerge = (first, second) => {
    const xOverlap = Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x);
    const yOverlap = Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y);
    const separatedX = first.x + first.w <= second.x || second.x + second.w <= first.x;
    const separatedY = first.y + first.h <= second.y || second.y + second.h <= first.y;
    return (yOverlap > 0 && separatedX) || (xOverlap > 0 && separatedY);
  };
  experiments.forEach((experiment) => {
    experiment.steps.forEach((step) => {
      step.expectedCalls.forEach((call) => {
        const label = `实验 ${experiment.id} 第 ${step.order} 步`;
        const args = call.args || {};
        ["droplet", "droplets", "droplets1", "droplets2"].forEach((key) => {
          const value = args[key];
          const rects = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
          rects.forEach((rect, index) => validateRect(rect, `${label} ${key}[${index}]`));
        });
        if ([args.x, args.y, args.w, args.h].every(Number.isInteger)) {
          validateRect(args, label);
        }
        if (call.tool === "merge" && Array.isArray(args.droplets1) && Array.isArray(args.droplets2)) {
          if (args.droplets1.length !== args.droplets2.length) {
            throw new Error(`${label} 的两组待合并液滴数量必须相同`);
          }
          args.droplets1.forEach((first, index) => {
            const second = args.droplets2[index];
            if (!canMerge(first, second)) {
              throw new Error(`${label} 的第 ${index + 1} 对液滴不满足单轴投影重叠、另一轴分离`);
            }
          });
        }
      });
    });
  });
}

function attachSteps(worksheet, experiments) {
  const experimentMap = new Map(experiments.map((experiment) => [experiment.id, experiment]));
  rowsByHeader(worksheet).forEach((row) => {
    const experimentId = String(row["实验编号"] || "").trim();
    const experiment = experimentMap.get(experimentId);
    if (!experiment) {
      throw new Error(`对话步骤表第 ${row.__row} 行引用了不存在的实验 ${experimentId || "（空）"}`);
    }
    const order = integer(row["步骤序号"], null, `实验 ${experimentId} 的步骤序号`, {
      min: 1,
      max: 100,
    });
    const prompt = String(row["Prompt"] || "").trim();
    if (!prompt) throw new Error(`实验 ${experimentId} 第 ${order} 步缺少 Prompt`);
    const expectedFinalDroplets = jsonValue(
      row["预期最终液滴 JSON"],
      null,
      `实验 ${experimentId} 第 ${order} 步的预期最终液滴`
    );
    if (expectedFinalDroplets !== null && !Array.isArray(expectedFinalDroplets)) {
      throw new Error(`实验 ${experimentId} 第 ${order} 步的预期最终液滴必须是数组`);
    }
    experiment.steps.push({
      order,
      prompt,
      expectedCalls: parseExpectedCalls(row, experimentId, order),
      expectedDeltaSteps:
        row["预期新增步骤数"] === ""
          ? null
          : integer(row["预期新增步骤数"], null, `实验 ${experimentId} 第 ${order} 步的预期新增步骤数`, {
              min: 0,
              max: 100000,
            }),
      expectedFinalDroplets,
      notes: String(row["备注"] || "").trim(),
    });
  });

  validateExperimentSteps(experiments);
}

function parseUnifiedWorkbook(workbook, worksheet) {
  const config = {
    experimentName: String(workbook.title || "批量实验").trim() || "批量实验",
    defaultRepeats: 1,
    concurrency: 1,
    timeoutSeconds: 240,
    defaultFollowupReply: "请使用默认参数并生成",
    maxFollowups: 3,
    rows: 120,
    cols: 140,
    configLabel: "当前配置",
  };
  const experiments = [];
  const experimentMap = new Map();
  const sourceRows = rowsByHeader(worksheet);
  sourceRows.forEach((row) => {
    const id = String(row["实验编号"] || "").trim();
    if (!id) throw new Error(`实验表第 ${row.__row} 行缺少实验编号`);
    const type = String(row["类型"] || "完整").trim();
    if (!EXPERIMENT_TYPES.has(type)) {
      throw new Error(`实验 ${id} 的类型必须是完整、缺省或多流程`);
    }
    const enabled = booleanValue(row["启用"], true);
    const repeats = integer(row["重复次数"], 1, `实验 ${id} 的重复次数`, { min: 1, max: 100 });
    let experiment = experimentMap.get(id);
    if (!experiment) {
      experiment = {
        enabled,
        category: String(row["大项"] || "").trim(),
        id,
        type,
        repeats,
        maxFollowups: config.maxFollowups,
        initialStepsText: "",
        selectedDroplets: [],
        notes: "",
        steps: [],
      };
      experimentMap.set(id, experiment);
      experiments.push(experiment);
    } else if (
      experiment.type !== type ||
      experiment.repeats !== repeats ||
      experiment.enabled !== enabled
    ) {
      throw new Error(`实验 ${id} 的类型、重复次数和启用状态必须保持一致`);
    }
    const order = integer(row["步骤"], null, `实验 ${id} 的步骤`, { min: 1, max: 100 });
    const prompt = String(row["Prompt"] || "").trim();
    if (!prompt) throw new Error(`实验 ${id} 第 ${order} 步缺少 Prompt`);
    experiment.steps.push({
      order,
      prompt,
      expectedCalls: parseFriendlyExpectedCalls(row, id, order),
      expectedDeltaSteps: null,
      expectedFinalDroplets: null,
      notes: String(row["备注"] || "").trim(),
    });
  });
  validateExperimentSteps(experiments);
  validateExpectedCalls(experiments, config);
  const enabled = experiments.filter((experiment) => experiment.enabled);
  if (!enabled.length) throw new Error("没有启用的实验");
  return {
    format: "llm-dmf-batch-input-v2",
    config,
    experiments,
    editorRows: sourceRows.map((row) => ({
      enabled: booleanValue(row["启用"], true),
      category: String(row["大项"] || "").trim(),
      id: String(row["实验编号"] || "").trim(),
      type: String(row["类型"] || "完整").trim(),
      repeats: Number(row["重复次数"] || 1),
      order: Number(row["步骤"] || 1),
      prompt: String(row["Prompt"] || "").trim(),
      expectedOperation: String(row["预期操作"] || "").trim(),
      expectedParameters: String(row["预期参数"] || "").trim(),
      notes: String(row["备注"] || "").trim(),
    })),
    totalRuns: enabled.reduce((total, experiment) => total + experiment.repeats, 0),
  };
}

async function parseWorkbookBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const experimentsSheet = workbook.getWorksheet("实验");
  if (experimentsSheet) {
    const headers = new Set();
    experimentsSheet.getRow(1).eachCell((cell) => headers.add(cellValue(cell)));
    if (headers.has("Prompt") && headers.has("预期操作")) {
      return parseUnifiedWorkbook(workbook, experimentsSheet);
    }
  }
  const configSheet = workbook.getWorksheet("运行配置");
  const stepsSheet = workbook.getWorksheet("对话步骤");
  if (!configSheet || !experimentsSheet || !stepsSheet) {
    throw new Error("工作簿必须包含运行配置、实验、对话步骤 3 张工作表");
  }
  const config = parseConfig(configSheet);
  const experiments = parseExperiments(experimentsSheet, config);
  const ids = new Set();
  experiments.forEach((experiment) => {
    if (ids.has(experiment.id)) throw new Error(`实验编号重复：${experiment.id}`);
    ids.add(experiment.id);
  });
  attachSteps(stepsSheet, experiments);
  validateExpectedCalls(experiments, config);
  const enabled = experiments.filter((experiment) => experiment.enabled);
  if (!enabled.length) throw new Error("没有启用的实验");
  return {
    format: "llm-dmf-batch-input-v1",
    config,
    experiments,
    totalRuns: enabled.reduce((total, experiment) => total + experiment.repeats, 0),
  };
}

function applyPlainSheetStyle(worksheet, widths) {
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: widths.length },
  };
  worksheet.getRow(1).font = { bold: true, color: { argb: "FF1F2937" } };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE5E7EB" },
  };
  worksheet.getRow(1).alignment = { vertical: "middle" };
  worksheet.getRow(1).height = 24;
  widths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
    worksheet.getColumn(index + 1).alignment = { vertical: "top", wrapText: true };
  });
}

function addTemplateGuidance(worksheet) {
  const notes = {
    "启用": "填写“是”或“否”。只有启用的实验会运行。",
    "大项": "可选。用于分组和输出目录命名。",
    "实验编号": "同一个多流程实验的每一步使用相同编号。",
    "类型": "完整：信息齐全；缺省：允许模型追问并自动回复；多流程：多行 Prompt 在同一会话中依次执行。",
    "重复次数": "同一实验运行多少次。多流程各行须保持一致。",
    "步骤": "单流程填 1；多流程按 1、2、3 连续填写。",
    "Prompt": "发送给正式网页后端的原始文字。",
    "预期操作": "用于自动判定。可选挤出生成、移动、混匀、阵列混匀、合并、阵列生成；留空则标记为待复核。",
    "预期参数": "用中文分号分隔，例如：数量=3；位置=20,24；方向=右；尺寸=1x1。这里描述工具输入，不是最终落点。",
    "备注": "可选，不参与判定。",
  };
  worksheet.getRow(1).eachCell((cell) => {
    const note = notes[String(cell.value || "")];
    if (note) cell.note = note;
  });
  worksheet.dataValidations.add("A2:A1000", {
    type: "list",
    allowBlank: false,
    formulae: ['"是,否"'],
  });
  worksheet.dataValidations.add("D2:D1000", {
    type: "list",
    allowBlank: false,
    formulae: ['"完整,缺省,多流程"'],
  });
  worksheet.dataValidations.add("H2:H1000", {
    type: "list",
    allowBlank: true,
    formulae: ['"挤出生成,移动,混匀,阵列混匀,合并,阵列生成,不判定"'],
  });
}

function rowValues(row) {
  if (Array.isArray(row)) return row;
  return [
    row.enabled === false || String(row.enabled).trim() === "否" ? "否" : "是",
    String(row.category || "").trim(),
    String(row.id || "").trim(),
    String(row.type || "完整").trim(),
    row.repeats ?? 1,
    row.order ?? 1,
    String(row.prompt || "").trim(),
    String(row.expectedOperation || "").trim(),
    String(row.expectedParameters || "").trim(),
    String(row.notes || "").trim(),
  ];
}

async function createInputWorkbookBuffer(rows, { title = "LLM-DMF 批量实验" } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LLM-DMF Batch Tool";
  workbook.created = new Date();
  workbook.title = String(title || "LLM-DMF 批量实验").trim() || "LLM-DMF 批量实验";

  const experiments = workbook.addWorksheet("实验");
  experiments.addRows([INPUT_HEADERS, ...(rows || []).map(rowValues)]);
  applyPlainSheetStyle(experiments, [10, 16, 14, 12, 12, 10, 58, 16, 46, 30]);
  addTemplateGuidance(experiments);
  workbook.calcProperties.fullCalcOnLoad = true;
  return workbook.xlsx.writeBuffer();
}

async function createTemplateBuffer() {
  return createInputWorkbookBuffer(TEMPLATE_ROWS);
}

function statusText(status) {
  return {
    passed: "通过",
    failed: "失败",
    review: "待复核",
    error: "运行错误",
    stopped: "已停止",
  }[status] || status || "";
}

function effectiveStatus(result) {
  const verdict = result?.manualReview?.verdict;
  return verdict === "passed" || verdict === "failed" ? verdict : result?.status;
}

function relativeLink(text, path) {
  return path ? { text, hyperlink: String(path).replaceAll("\\", "/") } : null;
}

async function createResultsBuffer(job) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "LLM-DMF Batch Tool";
  workbook.created = new Date(job.startedAt || Date.now());
  workbook.calcProperties.fullCalcOnLoad = true;
  const results = [...job.results].sort(
    (a, b) => a.experimentOrder - b.experimentOrder || a.repeatIndex - b.repeatIndex
  );

  const summary = workbook.addWorksheet("实验汇总");
  summary.addRow([
    "大项",
    "实验编号",
    "实验类型",
    "Prompt 数",
    "重复次数",
    "通过",
    "失败",
    "待复核",
    "运行错误",
    "通过率",
  ]);
  job.suite.experiments.filter((experiment) => experiment.enabled).forEach((experiment) => {
    const own = results.filter((result) => result.experimentId === experiment.id);
    const counts = (status) => own.filter((result) => effectiveStatus(result) === status).length;
    const rowNumber = summary.rowCount + 1;
    summary.addRow([
      experiment.category,
      experiment.id,
      experiment.type,
      experiment.steps.length,
      experiment.repeats,
      {
        formula: `COUNTIFS('逐次结果'!$B$2:$B$${Math.max(2, results.length + 1)},B${rowNumber},'逐次结果'!$G$2:$G$${Math.max(2, results.length + 1)},"通过")`,
        result: counts("passed"),
      },
      {
        formula: `COUNTIFS('逐次结果'!$B$2:$B$${Math.max(2, results.length + 1)},B${rowNumber},'逐次结果'!$G$2:$G$${Math.max(2, results.length + 1)},"失败")`,
        result: counts("failed"),
      },
      {
        formula: `COUNTIFS('逐次结果'!$B$2:$B$${Math.max(2, results.length + 1)},B${rowNumber},'逐次结果'!$G$2:$G$${Math.max(2, results.length + 1)},"待复核")`,
        result: counts("review"),
      },
      {
        formula: `COUNTIFS('逐次结果'!$B$2:$B$${Math.max(2, results.length + 1)},B${rowNumber},'逐次结果'!$G$2:$G$${Math.max(2, results.length + 1)},"运行错误")`,
        result: counts("error"),
      },
      {
        formula: `IF(E${rowNumber}=0,0,F${rowNumber}/E${rowNumber})`,
        result: experiment.repeats ? counts("passed") / experiment.repeats : 0,
      },
    ]);
  });
  applyPlainSheetStyle(summary, [18, 14, 14, 12, 12, 10, 10, 12, 12, 12]);
  summary.getColumn(10).numFmt = "0.0%";

  const runs = workbook.addWorksheet("逐次结果");
  runs.addRow([
    "大项",
    "实验编号",
    "实验类型",
    "重复序号",
    "自动判定",
    "人工判定",
    "最终状态",
    "人工判定时间",
    "失败步骤",
    "对话轮次",
    "自动回答次数",
    "累计步骤数",
    "输入 Token",
    "输出 Token",
    "总 Token",
    "耗时（秒）",
    "配置名称",
    "模型",
    "JSON",
    "TXT",
    "GIF",
    "原因",
  ]);
  results.forEach((result) => {
    runs.addRow([
      result.category,
      result.experimentId,
      result.experimentType,
      result.repeatIndex,
      statusText(result.status),
      result.manualReview?.verdict ? statusText(result.manualReview.verdict) : "",
      statusText(effectiveStatus(result)),
      result.manualReview?.reviewedAt || "",
      result.failedStep || null,
      result.conversationRounds,
      result.autoReplyCount,
      result.sequenceSteps,
      result.tokenUsage.inputTokens,
      result.tokenUsage.outputTokens,
      result.tokenUsage.totalTokens,
      result.elapsedSeconds,
      job.profile.name,
      job.profile.model,
      relativeLink("查看 JSON", result.relativePaths.json),
      relativeLink("查看 TXT", result.relativePaths.txt),
      relativeLink("查看 GIF", result.relativePaths.gif),
      result.reason,
    ]);
  });
  applyPlainSheetStyle(runs, [18, 14, 14, 12, 12, 12, 12, 24, 12, 12, 15, 14, 14, 14, 14, 14, 20, 22, 14, 14, 14, 42]);

  const details = workbook.addWorksheet("流程明细");
  details.addRow([
    "实验编号",
    "重复序号",
    "步骤序号",
    "Prompt",
    "预期调用",
    "实际调用",
    "状态",
    "操作正确",
    "参数正确",
    "项目序列一致",
    "边界正确",
    "自动回答次数",
    "新增步骤数",
    "输入 Token",
    "输出 Token",
    "耗时（秒）",
    "助手回复",
    "原因",
  ]);
  results.forEach((result) => {
    result.stepResults.forEach((step) => {
      details.addRow([
        result.experimentId,
        result.repeatIndex,
        step.order,
        step.prompt,
        JSON.stringify(step.expectedCalls),
        JSON.stringify(step.actualCalls),
        statusText(step.status),
        step.checks?.operationCorrect == null ? null : step.checks.operationCorrect ? "是" : "否",
        step.checks?.parametersCorrect == null ? null : step.checks.parametersCorrect ? "是" : "否",
        step.checks?.projectSequenceCorrect == null ? null : step.checks.projectSequenceCorrect ? "是" : "否",
        step.checks?.boundsCorrect == null ? null : step.checks.boundsCorrect ? "是" : "否",
        step.autoReplyCount,
        step.deltaSteps,
        step.tokenUsage.inputTokens,
        step.tokenUsage.outputTokens,
        step.elapsedSeconds,
        step.assistantReply,
        step.reason,
      ]);
    });
  });
  applyPlainSheetStyle(details, [14, 12, 12, 48, 50, 50, 12, 12, 12, 16, 12, 15, 14, 14, 14, 14, 48, 40]);

  const info = workbook.addWorksheet("运行信息");
  info.addRows([
    ["字段", "值"],
    ["格式", "llm-dmf-batch-results-v1"],
    ["实验名称", job.suite.config.experimentName],
    ["开始时间", job.startedAt],
    ["结束时间", job.finishedAt || null],
    ["输出目录", job.outputName],
    ["正式后端", job.backendUrl],
    ["后端版本", job.backendVersion],
    ["Git commit", job.provenance.gitCommit],
    ["工作区有未提交修改", job.provenance.gitDirty ? "是" : "否"],
    ["代码指纹 SHA-256", job.provenance.codeFingerprint],
    ["配置名称", job.profile.name],
    ["模型", job.profile.model],
    ["Base URL", job.profile.baseUrl],
    ["API Key 已配置", job.profile.hasApiKey ? "是" : "否"],
    ["默认追问回答", job.options.defaultFollowupReply],
    ["并发数", job.options.concurrency],
    ["总运行数", job.total],
    ["完成数", job.completed],
  ]);
  applyPlainSheetStyle(info, [28, 100]);

  return workbook.xlsx.writeBuffer();
}

module.exports = {
  createInputWorkbookBuffer,
  createResultsBuffer,
  createTemplateBuffer,
  parseWorkbookBuffer,
  statusText,
};
