"""Algerian wilaya (province) codes. Official: 01-58.

Algeria is divided into 58 wilayas as of 2021 (El M'Ghair and El Meniaa added, 2019).
Code is the first two digits of the CIN (positions 2-3).
"""

WILAYAS = [
    ("01", "Adrar"),
    ("02", "Chlef"),
    ("03", "Laghouat"),
    ("04", "Oum El Bouaghi"),
    ("05", "Batna"),
    ("06", "Bejaia"),
    ("07", "Biskra"),
    ("08", "Bechar"),
    ("09", "Blida"),
    ("10", "Bouira"),
    ("11", "Tamanrasset"),
    ("12", "Tebessa"),
    ("13", "Tlemcen"),
    ("14", "Tiaret"),
    ("15", "Tizi Ouzou"),
    ("16", "Algiers"),
    ("17", "Djelfa"),
    ("18", "Jijel"),
    ("19", "Setaif"),
    ("20", "Sidi Bel Abbes"),
    ("21", "Annaba"),
    ("22", "Guelma"),
    ("23", "Constantine"),
    ("24", "Medea"),
    ("25", "Mostaganem"),
    ("26", "M'Sila"),
    ("27", "Mascara"),
    ("28", "Ouargla"),
    ("29", "Oran"),
    ("30", "El Bayadh"),
    ("31", "Illizi"),
    ("32", "Bordj Bou Arreridj"),
    ("33", "Boumerdes"),
    ("34", "El Tarf"),
    ("35", "Tindouf"),
    ("36", "Tissemsilt"),
    ("37", "El Oued"),
    ("38", "Khenchela"),
    ("39", "Souk Ahras"),
    ("40", "Tipaza"),
    ("41", "Mila"),
    ("42", "Ain Defla"),
    ("43", "Naama"),
    ("44", "Ain Temouchent"),
    ("45", "Ghardaia"),
    ("46", "Relizane"),
    ("47", "Timimoun"),
    ("48", "Bordj Badji Mokhtar"),
    ("49", "Ouled Djellal"),
    ("50", "Beni Abbes"),
    ("51", "In Salah"),
    ("52", "In Guezzam"),
    ("53", "Touggourt"),
    ("54", "Djanet"),
    ("55", "El M'Ghair"),
    ("56", "El Meniaa"),
    ("57", "El Okrob"),
    ("58", "Alger Centre"),
]

# Reverse lookup: name -> code, code -> name
_BY_CODE = {c: n for c, n in WILAYAS}
_BY_NAME = {n: c for c, n in WILAYAS}


def by_code(code: str) -> str | None:
    return _BY_CODE.get(code)


def by_name(name: str) -> str | None:
    return _BY_NAME.get(name)


def codes() -> list[str]:
    return [c for c, _ in WILAYAS]


def names() -> list[str]:
    return [n for _, n in WILAYAS]


def random_wilaya() -> tuple[str, str]:
    import random

    return random.choice(WILAYAS)
