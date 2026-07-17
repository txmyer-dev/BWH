import {NextResponse} from 'next/server';

export const projectRedirect = (projectId: string, ownerToken: string) => {
  const response = new NextResponse(null, {
    status: 303,
    headers: {Location: `/projects/${projectId}`}
  });
  response.cookies.set(`legacy_owner_${projectId}`, ownerToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
  return response;
};
