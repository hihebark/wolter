declare module 'tdigest' {
  export class TDigest {
    push(x: number | number[]): void;
    compress(): void;
    percentile(p: number): number;
    size(): number;
  }
}
