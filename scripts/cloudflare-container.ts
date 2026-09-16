// Never start financial writers on an ephemeral container filesystem.
throw new Error("Financial runtime requires persistent journals; Cloudflare Container disk is ephemeral. Use the persistent-host deployment profile.");
export {};
