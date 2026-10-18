export async function runCoordinatedLocal(worker, args, inspectGoflow) {
  const { projectDirectory, explicitLocalRequest = false, ...task } = args;
  const goflow = await inspectGoflow(projectDirectory);
  const mode = goflow.ok ? goflow.status.mode : null;
  const invalidProject = goflow.blockingCategory === 'invalid_project';
  if (invalidProject || (!explicitLocalRequest && (!goflow.ok || mode !== 'auto'))) {
    return {
      status: mode === 'go' ? 'needs_goflow' : 'gpt_required',
      reason: invalidProject ? 'invalid_project' : mode === 'go' ? 'saved_force_go_mode'
        : mode === 'gpt' || mode === 'off' ? 'automatic_delegation_disabled' : 'coordination_mode_unavailable',
      attempts: 0, source: 'Local AI coordination',
      nextAction: mode === 'go' ? 'Use the existing guarded GoFlow workflow; no local inference was started.'
        : 'Use the current GPT session or resolve the mode check. An explicit user request for local inference can override saved routing preference.',
      coordination: { mode, blockingCategory: goflow.blockingCategory, cloudInference: false },
    };
  }
  return { ...await worker.run(task), coordination: { mode, explicitLocalRequest, cloudInference: false } };
}
