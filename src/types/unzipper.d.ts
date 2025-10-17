declare module 'unzipper' {
  import { Readable } from 'node:stream';

  export interface Entry {
    path: string;
    type: 'File' | 'Directory' | (string & {});
    uncompressedSize?: number;
    stream(): Readable;
  }

  export namespace Open {
    function file(path: string): Promise<{ files: Entry[] }>;
  }
}
