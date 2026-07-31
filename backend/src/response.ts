export type ApiResponse<T> = {
  code: 0 | 1;
  message: string;
  data: T | null;
};

export const success = <T>(data: T, message = 'success'): ApiResponse<T> => ({
  code: 1,
  message,
  data
});

export const failure = (message: string): ApiResponse<null> => ({
  code: 0,
  message,
  data: null
});
