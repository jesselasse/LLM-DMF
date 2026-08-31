# Missing-parameter baseline audit

- Sessions: 40 = 8 cases × 5 repeats
- Calls: 80 = 2 calls per session
- Model: deepseek-v4-flash
- Thinking: enabled
- Timeout: 240 seconds per call
- Conversation mode: transcript replay through the unchanged single-message baseline
- Detection: 22/40 = 55.0%
- Strict clarification accuracy: 11/22 detected sessions = 50.0%
- Task success: 6/40 = 15.0%
- Exact step matches: 6
- First-frame-ignored matches: 0
- Empty final step files: 3; counted as task failures
- Token total: 205033; average per two-turn session: 5126
- Stored/returned step disagreements: 0
- Independent comparison disagreements: 0
- Baseline SHA-256: 3b89b1090c4069fad0b1714c7ec1e0473394f3f3a129d58c621f85c1b3c8eee8
- Input SHA-256: 0ceb18480ae8638b1a64a22805b53c8b419dfa69cfa79bd116e30a6c545158c7

Clarification accuracy is conditional on detection. A clarification is correct only when it
requests the intentionally removed parameter without rejecting a valid case or requiring
unnecessary extra parameters. Manual decisions and reasons are in clarification-review.csv.

Important limitation: llm_txt_baseline.py accepts one HumanMessage and has no persistent chat
history. Turn 2 therefore replays Turn 1, the model's actual Turn-1 reply, and Turn 2 inside one
message. This is not a native role-preserving multi-turn conversation.
