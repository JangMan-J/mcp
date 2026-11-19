import type { Disposable, Extension, ExtensionHost } from '@mcp-client/core';
import { TASKS_ID } from './model.js';
import { TasksRuntime, type TasksOptions } from './runtime.js';
export { TASKS_ID, MemoryTaskStore, type TaskStatus, type TaskRecord, type TaskStore } from './model.js';
export { TasksRuntime, TaskHandle, type TasksOptions } from './runtime.js';

export class TasksExtension extends TasksRuntime implements Extension {
  readonly id = TASKS_ID;
  readonly stage = 'beta' as const;
  readonly defaultEnabled = false as const;
  readonly pin = 'cc9aaac1047a9440b07486e38f37060bbebeef4c';
  health() { return this.opts.healthy === false ? 'unavailable' : 'working'; }
  settings() { return this.health() === 'working' ? {} : undefined; }
  capabilities(isWorking: boolean): Record<string, Record<string,unknown>> {
    return isWorking && this.settings() ? {extensions:{[this.id]:{}}} : {};
  }
  attach(host: ExtensionHost): Disposable {
    if (!this.settings()) return {dispose() {}};
    return host.registerResultType('task', r => this.accept(r));
  }
}
export function createTasksExtension(opts?: TasksOptions) { return new TasksExtension(opts); }
