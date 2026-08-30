import { api } from '../api/client';
import { unlockAudio } from '../audio/ctx';
import { useCircuitStore } from '../circuit/circuitStore';
import { useProjectStore } from '../stores/project';
import { simSession, useSimStore } from '../stores/sim';
import { EngineWorkerClient } from './mpy/engine-client';
import { RemoteSessionClient } from './remote/session-client';

/**
 * 运行会话封装（03-§6.2 simSession 消费侧）：TopBar 运行组 → 引擎会话生命周期。
 * 运行用「当前画布电路 + 服务端 files」（M4 无代码编辑器，files 以服务端为准）。
 * 引擎A：wasm worker 本地执行；引擎B：POST /api/build → WS 会话 → QEMU（编译等待经 build.progress 推送）。
 */

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ▶ 运行（idle/paused/error 时可用；重复点击先释放旧会话） */
export async function runSession(): Promise<void> {
  // AudioContext 手势解锁（05-§1.8 E4）：▶ 运行属用户手势，一次性 resume
  unlockAudio();
  const { engineKind } = useSimStore.getState();

  simSession.dispose();
  useSimStore.getState().setStatus('loading');

  try {
    const current = useProjectStore.getState().current;
    if (!current) throw new Error('未打开工程');

    const circuit = useCircuitStore.getState().doc;
    if (!circuit) throw new Error('电路未加载');

    const detail = await api.getProject(current.id);

    if (engineKind === 'micropython-wasm') {
      const client = new EngineWorkerClient();
      simSession.attach(client);
      await client.load(circuit, { kind: 'sources', files: detail.files });
      client.start({ speed: useSimStore.getState().speed });
      return;
    }

    // 引擎B：load 内部完成 build 提交 + WS attach + 编译等待（status 经 building 推送）
    const client = new RemoteSessionClient();
    simSession.attach(client);
    await client.load(circuit, { kind: 'sources', files: detail.files });
    client.start();
  } catch (err) {
    simSession.dispose();
    useSimStore.getState().setStatus('error', toMessage(err));
  }
}

/** ⏸ 暂停（注入 KeyboardInterrupt） */
export function pauseSession(): void {
  simSession.engine?.pause();
}

/** ⟳ 重置（重建 wasm 实例，回到 idle；running 中禁用） */
export function resetSession(): void {
  simSession.engine?.reset();
}

/** ⏹ 停止会话 */
export function stopSession(): void {
  simSession.dispose();
}
