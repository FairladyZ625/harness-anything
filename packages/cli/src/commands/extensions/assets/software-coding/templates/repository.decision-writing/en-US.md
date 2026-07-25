# Decision Writing

A decision is written for an arbiter who must identify the judgment before
reviewing its evidence. Keep the verdict, its rationale, and its delivery work
in separate places so each reader can do one job at a time.

## Chosen

Each `chosen[].text` contains one sentence that the arbiter can approve or
reject directly. It answers the decision question; it does not prove the answer
or prescribe the implementation.

Several chosen entries are valid when one decision settles several parallel
judgments. This is the intended escape hatch for compound decisions: split
three judgments into three `--chosen` entries. Do not compress them into one
dense sentence, and do not combine their lengths as if splitting were a defect.

Each entry is limited to 120 Unicode characters. The limit was selected from a
2026-07-25 backtest of 503 decisions and 625 chosen entries: P25 was 113
characters, the median was 193, and 453 entries exceeded 120. The historical
distribution therefore measures accumulated debt, not a readability target.
The two human-confirmed readable examples were 59 and 103 characters; 120
admits both with headroom while rejecting the confirmed 501- and 722-character
paragraphs.

Good (`dec_01KYCF5V2FRM90QV68BC45JMJX`, 59 characters):

> 守卫那条「必须是 generic」是重构没做完的残留,应当去掉;把关交给紧随其后的内容比对检查(它已包含通道适配器)。

Too broad for one entry (`dec_01KYCA4Q2MZNHX4N8T3K06JG02` CH1,
722 characters; excerpt):

> 三条:(1)每条性质判据必须有常驻执行者,不是审计项目……;(2)存量清零追不上腐烂流量是算术问题不是执行力问题……;(3)远程线按参与者可追责性分两级……

The second example contains three independently adjudicable judgments. Its full
text belongs in the body and tasks; write three chosen entries.

## Body

The body explains why the chosen judgment is preferable. Put evidence,
tradeoffs, rejected alternatives, risks, and scope exclusions here. This lets
the arbiter first answer “is this the judgment?” and then inspect whether the
reasoning supports it.

Moving rationale out of chosen is not deleting information. It restores the
reading order: verdict first, proof second.

## Task

A task owns implementation requirements: files to change, migration steps,
tests, positive and negative controls, rollout order, and completion gates.
Those details may depend on the decision, but they are not part of the judgment
the arbiter is approving.

If chosen says both what is decided and exactly how to deliver it, later
implementation discoveries can make the decision appear to change. Keeping
delivery work in tasks preserves the decision while allowing the plan to
evolve.

## Repairing an overlong entry

When `ha decision propose` rejects an entry:

1. Underline every independently approvable judgment and pass each as its own
   `--chosen`.
2. Move every “because”, comparison, tradeoff, and evidence statement into
   `--body` or `--body-file`.
3. Move every command, file change, test obligation, rollout step, and delivery
   condition into a task.
4. Reread each chosen entry alone. The arbiter should be able to answer yes or
   no without first decoding the implementation plan.
