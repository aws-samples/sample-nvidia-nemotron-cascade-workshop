# Security

If you discover a potential security issue in this sample, do not create a
public GitHub issue.

For Amazon-owned samples, follow the reporting instructions shown in the
published repository's Security policy. If this repository has not yet been
published, report the issue to the repository owner through the private review
process used for publication.

## Credential Safety

This sample uses the AWS SDK default credential chain. Never commit:

- `.env.local`
- AWS access keys or session tokens
- AWS account IDs
- customer data
- private service URLs
