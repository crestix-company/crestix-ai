# FS Calendar detection rules

Deterministic title rules before any AI logic. **Medical FS MVP scope**: only
医療向け商談 (Medical) meetings are detected as `meetings` rows going forward.
HD (飲食・美容等) Calendar events, and legacy `【E1】`/`【E2】`/`【商談】`
markers from the earlier v1.2 naming convention, are no longer matched -
`detectFsMeeting` returns `null` for them, so Calendar Sync never creates or
updates a `meetings` row for a new event with one of those titles.

## Current rule set

| Calendar title pattern | meeting_type |
| --- | --- |
| `【お打ち合わせ①】` | `E1` |
| `【お打ち合わせ②】` | `E2` |

The current medical Calendar samples use forms such as:

- `【お打ち合わせ①】<医院名> 様`
- `リスケ【お打ち合わせ①】<医院名> 様`
- `キャンセル【お打ち合わせ①】<医院名> 様`

`キャンセル` or `無効商談` marks the detected meeting `CANCELLED`.

The bare substring `商談` is intentionally **not** a rule. Current Calendar data contains internal work items such as `商談動画...` and `最終商談内容...`; treating those as customer meetings creates false positives. If the business naming convention changes, update the deterministic rule config and tests first rather than delegating detection to an LLM.

## No longer detected (out of Medical FS MVP scope)

| Calendar title pattern | Historic meeting_type | Notes |
| --- | --- | --- |
| `【E1】` / `【E2】` | `E1` / `E2` | Legacy v1.2 markers, superseded by `【お打ち合わせ①】`/`【お打ち合わせ②】`. |
| `【HD...】` (e.g. `【HD①】`, `【HD回収】`, `【HDヒアリングMTG】`) | `HD` | 飲食・美容等 (non-medical) sales. |
| `【商談】` | `OTHER` | Generic explicit marker, retired. |

`meetings` rows already created under the old ruleset are **not deleted** -
they remain in the DB for audit/history. They are simply never surfaced by
the Medical FS UI (`/fs/meetings` and `/fs/meetings/[id]` only query
`meeting_type in ('E1', 'E2')`) and never become eligible for
auto-preparation or material generation, since `detectFsMeeting` no longer
produces `HD`/`OTHER`/legacy-`E1`/legacy-`E2` for *new* Calendar events. A
Calendar Sync pass that re-touches an existing out-of-scope event (its
title still matches nothing) leaves that event's already-created `meetings`
row alone rather than auto-cancelling it - see `upsertCalendarEventAndMeeting`
in `lib/google/calendar-sync.ts`.
