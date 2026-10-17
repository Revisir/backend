import type { BankState, IQuestionBank } from "@models/Topic.js";

/** The `questionBank` object in topic responses. Never carries questions or answers. */
export interface QuestionBankView {
  state: BankState;
  /** Questions available to draw now; previous questions count during a rebuild. */
  usableCount: number;
  /** Queued or building while previous questions remain usable. */
  rebuilding: boolean;
}

/** Public view of a stored bank. Topics saved before banks existed read as `none`. */
export function toQuestionBankView(bank?: Partial<IQuestionBank> | null): QuestionBankView {
  const state = bank?.state ?? "none";
  const usableCount = bank?.usableCount ?? 0;
  return {
    state,
    usableCount,
    rebuilding: (state === "queued" || state === "building") && usableCount > 0,
  };
}
