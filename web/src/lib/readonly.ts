// Global read-only switch (set while a super admin previews another user's view).
let readOnly = false;
export const setReadOnly = (v: boolean) => { readOnly = v; };
export const isReadOnly = () => readOnly;
