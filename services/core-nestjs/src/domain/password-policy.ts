export class InvalidPassword extends Error {}

export class PasswordPolicy {
  private readonly blockedPasswords: ReadonlySet<string>;

  constructor(blockedPasswords: ReadonlySet<string>) {
    this.blockedPasswords = blockedPasswords;
  }

  validate(input: string, hasVerifiedMfa: boolean): string {
    const password = input.normalize('NFC');
    const length = Array.from(password).length;
    const minimum = hasVerifiedMfa ? 8 : 15;
    if (length < minimum || length > 128) {
      throw new InvalidPassword(`La contraseña debe tener entre ${minimum} y 128 caracteres.`);
    }
    if (this.blockedPasswords.has(password.toLowerCase())) {
      throw new InvalidPassword('Elige una contraseña que no sea de uso común.');
    }
    return password;
  }
}
