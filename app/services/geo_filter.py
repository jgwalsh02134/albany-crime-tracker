# Improved Geo Filter - Wider Capital Region acceptance
NEARBY_TOWNS = {
    'albany', 'colonie', 'bethlehem', 'guilderland', 'coeymans', 'new scotland', 'rensselaerville', 'westerlo', 'berne', 'knox', 'voorheesville', 'green island', 'menands', 'watervliet',
    'brunswick', 'halfmoon', 'clifton park', 'malta', 'stillwater', 'mechanicville', 'ballston spa', 'burnt hills', 'scotia', 'rotterdam', 'niskayuna', 'east greenbush', 'north greenbush', 'sand lake', 'hoosick', 'pittstown', 'schaghticoke', 'schodack', 'nassau'
}

def should_accept_incident(incident):
    text = (incident.get('raw_text') or incident.get('description') or '').lower()
    for town in NEARBY_TOWNS:
        if town in text:
            return True, 'nearby_town_accepted'
    return False, 'rejected'
