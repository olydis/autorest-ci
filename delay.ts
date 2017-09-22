
export const delay = (s: number): Promise<void> => new Promise(res => setTimeout(res, 1000 * s));