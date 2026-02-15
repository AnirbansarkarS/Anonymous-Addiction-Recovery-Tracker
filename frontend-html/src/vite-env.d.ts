/// <reference types="vite/client" />

interface Window {
  midnight?: {
    [key: string]: {
        connect: () => Promise<any>;
        // other fields
    };
  };
}
