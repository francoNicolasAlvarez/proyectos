export function migrationFiles(): string[];
export function migrationSql(file: string): string;
export function allSql(): string;
export function applyPending(client: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }, log?: (m: string) => void): Promise<string[]>;
