/**
 * node:sqlite 最小类型声明（Node 22.5+ 内置；bun-types 未覆盖该模块）。
 * 仅声明 local-index.ts 适配层用到的面；运行时以 Node 实际实现为准。
 */
declare module "node:sqlite" {
	export class DatabaseSync {
		constructor(path: string, options?: Record<string, unknown>);
		exec(sql: string): void;
		prepare(sql: string): {
			run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
			all(...params: unknown[]): unknown[];
			get(...params: unknown[]): unknown;
		};
		close(): void;
	}
}
