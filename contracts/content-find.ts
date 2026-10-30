export interface ContentFindOptions {
  forward?: boolean;
  findNext?: boolean;
  matchCase?: boolean;
}

export interface ContentFindResult {
  matches: number;
  active: number;
  selectedText?: string;
}
