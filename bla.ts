let step = 1;

export function* baz() {
  // We get context from the .next(bar) call that flows to baz
  const context = yield;
  console.log("[baz] context =", context);
  const newContext = { ...context, "bar": "baz" };
  return newContext;
}

export function* foo(context: Record<string, string>) {
  console.log(`[foo] Step: ${step++} | Value: ${context["foo"]}`);
  // We retrieve the new bar by assigning the yield instruction
  const newContext = yield* baz();
  // TODO: We want to "refresh" generator context without assigning to new variables!
  console.log(`[foo] Step: ${step++} | Value: ${newContext["bar"]}`);
}

if (import.meta.main) {
  const bar = {
    "foo": "bar",
  }

  const genFoo = foo(bar);
  const next1 = genFoo.next();
  console.log("[main] next1 =", next1);
  const next2 = genFoo.next(bar);
  console.log("[main] next2 =", next2);
}
