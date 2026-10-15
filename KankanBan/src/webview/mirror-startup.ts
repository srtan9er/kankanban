/** A mirror starts only after it has received authoritative state. */
export async function waitForMirrorSnapshot(request:()=>Promise<unknown>,firstSnapshot:Promise<unknown>):Promise<void>{
 // The writer's boot broadcast may fulfill the read even if the first RPC was
 // emitted before its listener existed. This race is for startup reads only.
 await Promise.race([firstSnapshot,request()]);
}
