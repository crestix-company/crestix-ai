# FS Calendar detection rules

Phase 1 uses deterministic title rules before any AI logic.

## Current rule set

| Calendar title pattern | meeting_type |
| --- | --- |
| `【お打ち合わせ①】` | `E1` |
| `【お打ち合わせ②】` | `E2` |
| `【E1】` | `E1` |
| `【E2】` | `E2` |
| `【HD...】` | `HD` |
| `【商談】` | `OTHER` |

The current medical Calendar samples use forms such as:

- `【お打ち合わせ①】<医院名> 様`
- `リスケ【お打ち合わせ①】<医院名> 様`
- `キャンセル【お打ち合わせ①】<医院名> 様`

`キャンセル` or `無効商談` marks the detected meeting `CANCELLED`.

The bare substring `商談` is intentionally **not** a rule. Current Calendar data contains internal work items such as `商談動画...` and `最終商談内容...`; treating those as customer meetings creates false positives. If the business naming convention changes, update the deterministic rule config and tests first rather than delegating detection to an LLM.
