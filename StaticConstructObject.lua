-- StaticConstructObject_Internal for Whiskerwood (UE 5.6.0-0, Win64 Shipping)
-- Located via: execSpawnObject -> UGameplayStatics::SpawnObject -> tail call.
-- Prologue shape matches the shipped Drainsim signature; unique match in the exe.
-- Static RVA 0x15BDC70 (ImageBase 0x140000000 -> VA 0x1415BDC70)
function Register()
    return "4C 8B DC 55 53 41 56 49 8D AB ? ? ? ? 48 81 EC ? ? ? ? 48 8B 05 ? ? ? ? 48 33 C4 48 89 85 ? ? ? ? 8B 41"
end

function OnMatchFound(MatchAddress)
    return MatchAddress
end
