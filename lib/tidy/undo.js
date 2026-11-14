/**
 * 撤销账本：每批整理写一条记录到 <pluginRoot>/data/undo.json，
 * 只保留最近若干批；撤销时按相反顺序执行逆操作。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export class UndoStore {
  constructor(file, options = {}) {
    this.file = file;
    this.limit = Number.isFinite(options.limit) ? options.limit : 5;
    this.state = { version: 1, batches: [] };
    this.ready = null;
    this.writing = Promise.resolve();
  }

  async load() {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
          if (raw && Array.isArray(raw.batches)) {
            this.state = { version: 1, batches: raw.batches.slice(0, this.limit) };
          }
        } catch {
          /* 首次运行 / 文件损坏：从空账本开始 */
        }
        return this.state;
      })();
    }
    return this.ready;
  }

  async persist() {
    const run = async () => {
      const dir = path.dirname(this.file);
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, this.file);
    };
    this.writing = this.writing.then(run, run);
    await this.writing;
  }

  /** 记录一批已成功执行的动作；同一 batchId 的多次提交合并为一批。 */
  async append(batch) {
    await this.load();
    const actions = batch.actions ?? [];
    const existing = this.state.batches.find((entry) => entry.id === batch.id && !entry.undone);
    if (existing) {
      existing.actions.push(...actions);
      existing.ts = Math.max(existing.ts, batch.ts ?? Date.now());
      await this.persist();
      return existing;
    }
    const entry = {
      id: batch.id,
      ts: batch.ts ?? Date.now(),
      undone: false,
      actions,
    };
    this.state.batches.unshift(entry);
    this.state.batches = this.state.batches.slice(0, this.limit);
    await this.persist();
    return entry;
  }

  /** 最近一批尚未撤销且包含可逆动作的记录。 */
  async lastUndoable() {
    await this.load();
    return this.state.batches.find((batch) => !batch.undone && batch.actions.length > 0) ?? null;
  }

  async markUndone(batchId) {
    await this.load();
    const batch = this.state.batches.find((entry) => entry.id === batchId);
    if (batch) {
      batch.undone = true;
      batch.undoneAt = Date.now();
      await this.persist();
    }
    return batch ?? null;
  }

  /** 对外展示的摘要（不含完整动作列表）。 */
  summary() {
    return this.state.batches.map((batch) => ({
      id: batch.id,
      ts: batch.ts,
      undone: Boolean(batch.undone),
      undoneAt: batch.undoneAt ?? null,
      count: batch.actions.length,
      renames: batch.actions.filter((action) => action.kind === 'rename').length,
      archives: batch.actions.filter((action) => action.kind === 'archive').length,
      unarchives: batch.actions.filter((action) => action.kind === 'unarchive').length,
    }));
  }
}
