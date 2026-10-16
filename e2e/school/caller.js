// Private test-process caller, using the actual Service Binding RPC transport.
export default { async fetch(request, env) {
  const {action, args} = await request.json();
  if (action === 'mail') return Response.json(await env.MAIL.deliver(args));
  if (action === 'directory') return Response.json(await env.AUTH.cquExternalDirectory(args));
  if (action === 'workflow') return Response.json(await env.OBSERVER.status(args.id));
  throw new Error('Unsupported fixture action');
}};
