export interface DataSource {
  query: (
    query: any,
    callback: (err: any, results: any) => {},
    collectionName?: string,
  ) => {};
  end: () => {};
}
