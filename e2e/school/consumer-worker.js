// A real, separate caller Worker. This proves composition/RPC/D1 transport;
// Schedule/QuickLogin retain ownership of their production business journeys.
export default {async fetch(request,env) {
  const identity=await env.AUTH_HTTP.fetch(`${env.AUTH_ORIGIN}/api/v1/auth/get-session`,{
    headers:{cookie:request.headers.get('cookie') ?? ''},
  });
  const session=await identity.json();
  if(!identity.ok || !session?.user?.id) return Response.json({error:'UNAUTHENTICATED'},{status:401});
  if (env.EXTERNAL_DIRECTORY_USER_ID && env.EXTERNAL_DIRECTORY_USER_ID !== session.user.id) {
    return Response.json({error:'DIRECTORY_USER_MISMATCH'},{status:403});
  }
  const result=await env.AUTH.cquExternalDirectory({
    clientId:env.AUTH_CLIENT_ID,clientSecret:env.AUTH_CLIENT_SECRET,userId:session.user.id,
    kind:'catalog',sourceType:'course_catalog',expectedSessionId:'202610',
  });
  if(result.error) return Response.json(result,{status:403});
  await env.SCHEDULE_DB.prepare('CREATE TABLE IF NOT EXISTS imported_course(id TEXT PRIMARY KEY,name TEXT,code TEXT)').run();
  for(const item of result.items) await env.SCHEDULE_DB.prepare('INSERT OR REPLACE INTO imported_course VALUES (?,?,?)')
    .bind(item.id,item.name,item.courseCode).run();
  return Response.json({items:result.items,directoryUserId:env.EXTERNAL_DIRECTORY_USER_ID ?? null,consumerLabel:env.CONSUMER_LABEL ?? null});
}};
