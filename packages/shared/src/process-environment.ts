/** Deliberately excludes NODE_OPTIONS, loaders, Python injection and parent secrets. */
export function childEnvironment(overrides:Record<string,string|undefined>,parent:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  const env:NodeJS.ProcessEnv={};
  for(const name of ['PATH','LANG','LC_ALL','TZ','SYSTEMROOT','SSL_CERT_FILE','SSL_CERT_DIR'])if(parent[name])env[name]=parent[name];
  for(const [name,value] of Object.entries(overrides))if(value!==undefined)env[name]=value;
  return env;
}
