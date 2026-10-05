import { X509Certificate, createPrivateKey } from 'node:crypto';
import { isIP } from 'node:net';

export function certificateNeedsRenewal({ cert, key, root, names, now = Date.now() }) {
  try {
    const leaf = new X509Certificate(cert),
      ca = new X509Certificate(root);
    return (
      leaf.ca ||
      !leaf.checkIssued(ca) ||
      !leaf.verify(ca.publicKey) ||
      !leaf.checkPrivateKey(createPrivateKey(key)) ||
      Date.parse(leaf.validFrom) > now ||
      Date.parse(leaf.validTo) < now + 30 * 86400000 ||
      names.some((name) => !(isIP(name) ? leaf.checkIP(name) : leaf.checkHost(name)))
    );
  } catch {
    return true;
  }
}
