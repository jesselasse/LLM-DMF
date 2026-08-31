# Benchmark step 比较

`测试样例7.txt` 按文件中的分类顺序定义 `text1` 至 `text40`。每个分类下的 `项目-case1.txt` 至 `项目-case5.txt` 是对应 Prompt 的正确激活序列。

比较一次 batch tester 结果：

```bash
npm run benchmark:compare -- ".local/projects/项目名/runs/某次运行"
```

脚本会递归寻找结果 `.txt`，支持两种名称：

- Batch tester 原始名称，例如 `20260812-move-E031-01-当前配置.txt`
- 统一名称，例如 `move-text31-case1.txt`

要求：

- 默认必须覆盖 `text1` 至 `text40`，否则返回失败。
- 若只想检查部分结果，在命令末尾增加 `--partial`。
- 每个结果必须是有效 step 文本，每行格式为 `(x,y)(w,h);...-duration`。
- 比较前会规范化空格和换行。步骤顺序、每步液滴顺序、坐标、尺寸及 duration 必须一致。
- 同一个 `textX-caseX` 不能在结果目录中出现两次。
- 退出码 `0` 表示全部一致，`1` 表示存在不一致或缺失，`2` 表示目录、命名或文件结构错误。

脚本只读 benchmark 和结果目录，不会修改测试结果。
