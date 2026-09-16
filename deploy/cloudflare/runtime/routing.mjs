import {serviceForPath} from "../static/web-edge.mjs";
export function portForPath(pathname,method){return {API:4100,INDEXER:4300,MARKET_GATEWAY:4500}[serviceForPath(pathname,method)]??null;}
