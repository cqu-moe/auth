export interface ApiSuccess<T> {
  data: T;
}

export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiProblem {
  type: "about:blank";
  title: string;
  status: number;
  detail: string;
  code: string;
}
