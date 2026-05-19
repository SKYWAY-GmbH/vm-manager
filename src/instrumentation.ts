export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { ensureManualRuntimeReconcilerStarted } = await import(
    "./lib/kubevirt/manual-runtime-reconciler"
  );
  ensureManualRuntimeReconcilerStarted();
}
