import { useEffect, useState } from "react";

/**
 * The answer to a question to the backend, asked again when the question
 * changes. The answer before stays until the next one is there.
 */
export function useQuery<T>(ask: () => Promise<T>, deps: readonly unknown[]): T | null {
  const [answer, setAnswer] = useState<T | null>(null);
  useEffect(() => {
    let stale = false;
    ask()
      .then((value) => !stale && setAnswer(value))
      .catch((e) => console.error("query failed", e));
    return () => {
      stale = true;
    };
    // The caller says what the question depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return answer;
}
