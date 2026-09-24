// Release build: nothing is intercepted and app mocks do nothing.
export const installNetwork = (): void => {}
export const mock = () => ({ id: '', remove: () => false })
export const mockRequests = () => () => {}
export const networkTools = () => ({})
