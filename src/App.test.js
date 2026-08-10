import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

beforeEach(() => {
  window.localStorage.clear();
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () =>
      url === "/api/local-settings"
        ? JSON.stringify({ activeProfileId: "", profiles: [], presets: null })
        : "{}",
  }));
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: jest.fn(),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      clearRect: jest.fn(),
      fillRect: jest.fn(),
      strokeRect: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      stroke: jest.fn(),
      fillText: jest.fn(),
      setTransform: jest.fn(),
    }),
  });
});

function openPresets() {
  fireEvent.click(screen.getByRole("button", { name: "展开预设" }));
}

test("renders core sections", () => {
  render(<App />);
  expect(screen.queryByText("Digital Microfluidics Grid Basics")).not.toBeInTheDocument();
  expect(screen.getByLabelText("加载 TXT 步骤文件")).toBeInTheDocument();
  expect(screen.getByText("导入步骤")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "步骤" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导出日志" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导出步骤" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导出 JSON 上下文" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送消息" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "新建对话" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "缩小" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "适应" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "放大" })).toBeInTheDocument();
  expect(screen.getByLabelText("X axis")).toBeInTheDocument();
  expect(screen.getByLabelText("Y axis")).toBeInTheDocument();
});

test("grid zoom controls change scale and fit restores the global view", () => {
  render(<App />);
  const scaleIndicator = screen.getByLabelText("缩放");

  expect(scaleIndicator).toHaveTextContent("10%");
  fireEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(scaleIndicator).toHaveTextContent("13%");
  fireEvent.click(screen.getByRole("button", { name: "适应" }));
  expect(scaleIndicator).toHaveTextContent("10%");
});

test("grid pointer coordinates remain aligned with the canvas", () => {
  const { container } = render(<App />);
  const canvas = container.querySelector("canvas");
  canvas.getBoundingClientRect = () => ({
    left: 100,
    top: 50,
    right: 1500,
    bottom: 1250,
    width: 1400,
    height: 1200,
  });

  fireEvent.mouseMove(canvas, { clientX: 265, clientY: 375 });
  expect(screen.getByText("(16, 32)")).toBeInTheDocument();
});

test("step progress slider seeks without changing the loaded sequence", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    if (url === "/api/session-state") {
      return { ok: true, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          turnIndex: 0,
          baseStepCount: 0,
          assistantReply: "已生成",
          stepsText:
            "(1,1)(1,1)-1000\n(2,1)(1,1)-1000\n(3,1)(1,1)-1000",
          selectedDroplets: [],
        }),
    };
  });

  render(<App />);
  const progress = screen.getByRole("slider", { name: "步骤进度" });
  expect(progress).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(progress).toBeEnabled());
  expect(progress).toHaveAttribute("max", "2");

  fireEvent.change(progress, { target: { value: "2" } });
  expect(screen.getByText("步骤 3 / 3")).toBeInTheDocument();
  expect(progress).toHaveValue("2");

  fetchMock.mockRestore();
});

test("presets still fill the composer and new conversation restores the initial prompt", () => {
  render(<App />);
  const input = screen.getByRole("textbox", { name: "对话输入" });

  openPresets();
  fireEvent.click(screen.getByRole("button", { name: "PCR" }));
  expect(input).toHaveValue("PCR示例：在（20，20）向右生成3个液滴，再向下移动6步。");

  fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
  expect(input).toHaveValue("在（20，20）向右生成3个液滴");
});

test.each([
  ["挤出生成", "在（20，20）向右挤出式生成 1 个尺寸为 1×1 的液滴"],
  ["多挤出生成", "在（20，24）向右挤出生成 3 个尺寸为 1×1 的液滴"],
  ["移动", "将位于（20，20）的 1 个尺寸为 1×1 的液滴向右移动 20 格"],
  ["混合", "对位于（20，20）的 1 个尺寸为 1×1 的液滴做 3 圈旋转混匀"],
  ["阵列混合", "对 3 个尺寸为 1×1 的液滴并行做 3 圈阵列混匀"],
])("preset %s fills the exact requested prompt", (label, prompt) => {
  render(<App />);
  openPresets();
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(screen.getByRole("textbox", { name: "对话输入" })).toHaveValue(prompt);
});

test("send button keeps the existing backend request contract", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        assistantReply: "收到",
        stepsText: "(14,21)(1,1)-1000",
        tokenUsage: {
          available: true,
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
        sessionTokenUsage: {
          available: true,
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
      }),
  });

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

  const generationCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === "/api/steps-from-message");
  await waitFor(() => expect(generationCalls()).toHaveLength(1));
  const [url, options] = generationCalls()[0];
  const body = JSON.parse(options.body);
  expect(url).toBe("/api/steps-from-message");
  expect(options.method).toBe("POST");
  expect(body.message).toBe("在（20，20）向右生成3个液滴");
  expect(body.sessionId).toMatch(/^dmf-/);
  expect(body.selectedDroplets).toEqual([]);
  expect(body).not.toHaveProperty("llmConfig");
  expect(screen.getByRole("textbox", { name: "对话输入" })).toHaveValue("");
  const rawDetails = await screen.findByText("原始后端输出");
  expect(rawDetails.closest("details")).not.toHaveAttribute("open");
  expect(screen.getByLabelText("Backend Raw Output")).toHaveTextContent(
    '"assistantReply":"收到"'
  );
  const stepsDetails = await screen.findByText("生成的步骤");
  expect(stepsDetails.closest("details")).not.toHaveAttribute("open");
  expect(screen.getByLabelText("Backend Result Text")).toHaveTextContent(
    "(14,21)(1,1)-1000"
  );
  const tokenUsage = screen.getByLabelText("Token 用量");
  expect(tokenUsage).toHaveTextContent("本轮");
  expect(tokenUsage).toHaveTextContent("输入 120");
  expect(tokenUsage).toHaveTextContent("输出 30");
  expect(tokenUsage).toHaveTextContent("总计 150");
  expect(tokenUsage).toHaveTextContent("会话 150");

  fetchMock.mockRestore();
});

test("saved LLM settings use a local profile without leaking into context exports", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    if (url === "/api/local-settings/profile") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          activeProfileId: "profile-1",
          profiles: [{
            id: "profile-1",
            name: "默认配置",
            baseUrl: "https://custom.example/v1",
            model: "custom-model",
            hasApiKey: true,
          }],
          presets: null,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(
        url === "/api/local-settings"
          ? { activeProfileId: "", profiles: [], presets: null }
          : { assistantReply: "收到", stepsText: "(14,21)(1,1)-1000" }
      ),
    };
  });
  let writtenBlob;
  const write = jest.fn(async (blob) => {
    writtenBlob = blob;
  });
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: jest.fn().mockResolvedValue({
      createWritable: async () => ({ write, close: jest.fn() }),
    }),
  });

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "界面设置" }));
  fireEvent.change(screen.getByRole("textbox", { name: "API 地址" }), {
    target: { value: "https://custom.example/v1" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "temporary-secret-key" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "模型" }), {
    target: { value: "custom-model" },
  });
  expect(screen.getByText("内容有变化，保存后才会用于聊天请求。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  expect(await screen.findByText("已保存到本地，将用于后续请求。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

  const generationCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === "/api/steps-from-message");
  await waitFor(() => expect(generationCalls()).toHaveLength(1));
  const requestBody = JSON.parse(generationCalls()[0][1].body);
  expect(requestBody.llmConfig).toEqual({
    baseUrl: "https://custom.example/v1",
    model: "custom-model",
  });
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(
    "temporary-secret-key"
  );

  fireEvent.click(screen.getByRole("button", { name: "导出 JSON 上下文" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  const exportedText = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(writtenBlob);
  });
  expect(exportedText).not.toContain("temporary-secret-key");
  expect(exportedText).not.toContain("https://custom.example/v1");
  expect(exportedText).not.toContain("custom-model");

  fetchMock.mockRestore();
  delete window.showSaveFilePicker;
});

test("LLM connection test uses draft settings without saving them", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    if (url === "/api/llm-config/test") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, latencyMs: 42 }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    };
  });

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "界面设置" }));
  fireEvent.change(screen.getByRole("textbox", { name: "API 地址" }), {
    target: { value: "https://custom.example/v1" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "temporary-secret-key" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "模型" }), {
    target: { value: "custom-model" },
  });
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

  const testCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === "/api/llm-config/test");
  await waitFor(() => expect(testCalls()).toHaveLength(1));
  expect(JSON.parse(testCalls()[0][1].body)).toEqual({
    llmConfig: {
      baseUrl: "https://custom.example/v1",
      apiKey: "temporary-secret-key",
      model: "custom-model",
    },
  });
  expect(
    await screen.findByText(
      "连接成功，耗时 42 ms。 内容有变化，保存后才会用于聊天请求。"
    )
  ).toBeInTheDocument();

  fetchMock.mockRestore();
});

test("available models can be loaded from a custom OpenAI-compatible API", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    if (url === "/api/llm-config/models") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          models: ["model-a", "model-b"],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "{}",
    };
  });

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "界面设置" }));
  fireEvent.change(screen.getByRole("textbox", { name: "API 地址" }), {
    target: { value: "https://custom.example/v1" },
  });
  fireEvent.change(screen.getByLabelText("API Key"), {
    target: { value: "plain-key" },
  });
  fireEvent.click(screen.getByRole("button", { name: "获取模型" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/llm-config/models",
    expect.objectContaining({ method: "POST" })
  ));
  expect(await screen.findByText("已获取 2 个模型，可在输入框中选择。")).toBeInTheDocument();
  expect(document.querySelector('#llmModelOptions option[value="model-a"]')).not.toBeNull();
  expect(document.querySelector('#llmModelOptions option[value="model-b"]')).not.toBeNull();

  fetchMock.mockRestore();
});

test("local profiles load automatically and config export requires explicit secret opt-in", async () => {
  const write = jest.fn(async () => {});
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: jest.fn().mockResolvedValue({
      createWritable: async () => ({ write, close: jest.fn() }),
    }),
  });
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
      url === "/api/local-settings"
        ? JSON.stringify({
            activeProfileId: "profile-a",
            profiles: [{
              id: "profile-a",
              name: "Profile A",
              baseUrl: "https://example.test/v1",
              model: "model-a",
              hasApiKey: true,
            }],
            presets: [],
          })
        : JSON.stringify({ version: 1, activeProfileId: "profile-a", profiles: [] }),
  }));

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "界面设置" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "配置名称" })).toHaveValue("Profile A")
  );
  expect(screen.getByLabelText("API Key")).toHaveAttribute(
    "placeholder",
    "已在本地保存，留空继续使用"
  );

  fireEvent.click(screen.getByRole("button", { name: "导出配置" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/local-settings/export?includeSecrets=false"
  );

  fireEvent.click(screen.getByRole("checkbox", { name: "导出时包含 API Key" }));
  fireEvent.click(screen.getByRole("button", { name: "导出配置" }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/local-settings/export?includeSecrets=true"
  );

  fetchMock.mockRestore();
  delete window.showSaveFilePicker;
});

test("interface settings switch language and theme without changing prompt data", () => {
  render(<App />);
  const prompt = screen.getByRole("textbox", { name: "对话输入" });

  fireEvent.click(screen.getByRole("button", { name: "界面设置" }));
  fireEvent.click(screen.getByRole("button", { name: "深色" }));
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(window.localStorage.getItem("dmf-ui-theme")).toBe("dark");

  fireEvent.click(screen.getByRole("button", { name: "English" }));
  expect(screen.queryByText("Digital Microfluidics Grid Basics")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("lang", "en");
  expect(window.localStorage.getItem("dmf-ui-locale")).toBe("en");
  expect(prompt).toHaveValue("在（20，20）向右生成3个液滴");
});

test("enter sends and clears while shift enter keeps editing", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ assistantReply: "收到", stepsText: "" }),
  });

  render(<App />);
  const input = screen.getByRole("textbox", { name: "对话输入" });
  fireEvent.change(input, { target: { value: "测试 Enter 发送" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

  const generationCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === "/api/steps-from-message");
  await waitFor(() => expect(generationCalls()).toHaveLength(1));
  expect(JSON.parse(generationCalls()[0][1].body).message).toBe("测试 Enter 发送");
  expect(input).toHaveValue("");

  fireEvent.change(input, { target: { value: "继续编辑" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
  expect(generationCalls()).toHaveLength(1);
  expect(input).toHaveValue("继续编辑");

  fetchMock.mockRestore();
});

test("composer grows with multiline input and caps its height", () => {
  render(<App />);
  const input = screen.getByRole("textbox", { name: "对话输入" });

  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    value: 118,
  });
  fireEvent.change(input, { target: { value: "第一行\n第二行\n第三行\n第四行" } });
  expect(input).toHaveStyle({ height: "120px", overflowY: "hidden" });

  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    value: 220,
  });
  fireEvent.change(input, { target: { value: "更多内容\n".repeat(12) } });
  expect(input).toHaveStyle({ height: "160px", overflowY: "auto" });
});

test("editing a sent turn regenerates it without discarding earlier context", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (url, options) => {
    if (url === "/api/session-state") {
      return { ok: true, json: async () => ({}) };
    }
    const body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          turnIndex: body.editTurnIndex ?? 0,
          baseStepCount: 0,
          assistantReply: body.editTurnIndex === 0 ? "修改后的回复" : "第一次回复",
          stepsText: "",
          selectedDroplets: [],
        }),
    };
  });

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  expect(await screen.findByText("第一次回复")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "编辑这条消息" }));
  const input = screen.getByRole("textbox", { name: "对话输入" });
  expect(input).toHaveValue("在（20，20）向右生成3个液滴");
  expect(screen.getByText(/正在编辑第 1 轮/)).toBeInTheDocument();

  fireEvent.change(input, { target: { value: "修改后的要求" } });
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));

  const generationCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url === "/api/steps-from-message");
  await waitFor(() => expect(generationCalls()).toHaveLength(2));
  expect(JSON.parse(generationCalls()[1][1].body)).toMatchObject({
    message: "修改后的要求",
    editTurnIndex: 0,
  });
  expect(await screen.findByText("修改后的回复")).toBeInTheDocument();
  expect(screen.queryByText("第一次回复")).not.toBeInTheDocument();

  fetchMock.mockRestore();
});

test("failed send restores the message for retry", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    if (url === "/api/session-state") {
      return { ok: true, json: async () => ({}) };
    }
    return {
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ error: "temporary failure" }),
    };
  });

  render(<App />);
  const input = screen.getByRole("textbox", { name: "对话输入" });
  fireEvent.change(input, { target: { value: "请稍后重试" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

  expect(await screen.findByText("错误：temporary failure")).toBeInTheDocument();
  expect(input).toHaveValue("请稍后重试");

  fetchMock.mockRestore();
});

test("preset manager can create and reuse a local preset", () => {
  render(<App />);
  openPresets();
  fireEvent.click(screen.getByRole("button", { name: "管理预设" }));
  fireEvent.click(screen.getByRole("button", { name: "＋" }));
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
    target: { value: "我的操作" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "内容" }), {
    target: { value: "自定义液滴操作" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存预设" }));
  fireEvent.click(screen.getByRole("button", { name: "我的操作" }));

  expect(screen.getByRole("textbox", { name: "对话输入" })).toHaveValue(
    "自定义液滴操作"
  );
  expect(window.localStorage.getItem("dmf-chat-presets-v1")).toContain("我的操作");
});

test("preset manager can delete a built-in preset and keep that choice locally", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({}),
  });
  const { unmount } = render(<App />);
  openPresets();
  fireEvent.click(screen.getByRole("button", { name: "管理预设" }));
  fireEvent.click(screen.getByRole("button", { name: "删除预设" }));

  expect(screen.queryByRole("button", { name: "PCR" })).not.toBeInTheDocument();
  await waitFor(() =>
    expect(window.localStorage.getItem("dmf-chat-presets-v1")).not.toContain('"id":"pcr"')
  );

  unmount();
  render(<App />);
  openPresets();
  expect(screen.queryByRole("button", { name: "PCR" })).not.toBeInTheDocument();
  fetchMock.mockRestore();
});

test("presets are collapsed by default and can be expanded again", () => {
  render(<App />);
  const toggle = screen.getByRole("button", { name: "展开预设" });

  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "PCR" })).not.toBeInTheDocument();

  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "收起预设" })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  expect(screen.getByRole("button", { name: "PCR" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "收起预设" }));
  expect(screen.queryByRole("button", { name: "PCR" })).not.toBeInTheDocument();
});
