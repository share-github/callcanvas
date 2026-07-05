function resolveSqlitePath(p: string): string {
  return p.trim();
}

export const createPrismaAdapter = (): number => {
  return resolveSqlitePath("db").length;
};
