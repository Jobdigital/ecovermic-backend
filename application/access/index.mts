export const ADULT_AGE = 18;

export type Access = {
    level: "full" | "limited";
    // Canjes presenciales: requieren mayoría de edad con edad verificada
    canRedeemInPerson: boolean;
    // Publicar productos y aceptar ofertas: solo mayores de edad
    canPublishAndAcceptOffers: boolean;
    // Un menor requiere definir la intervención de su representante legal
    requiresLegalGuardian: boolean;
    ageVerified: boolean;
};

export function getAccess(age: number, ageVerified: boolean): Access {
    const adult = age >= ADULT_AGE;
    return {
        level: adult ? "full" : "limited",
        canRedeemInPerson: adult && ageVerified,
        canPublishAndAcceptOffers: adult,
        requiresLegalGuardian: !adult,
        ageVerified,
    };
}
