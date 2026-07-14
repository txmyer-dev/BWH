import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  // Google client libraries load platform metadata dynamically and must remain
  // native Node dependencies instead of being rewritten by the server bundler.
  serverExternalPackages: ['@google-cloud/tasks', 'google-auth-library']
};

export default nextConfig;
