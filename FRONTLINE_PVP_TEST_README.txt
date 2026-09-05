FRONTLINE COMMANDER – TEST MED TVÅ SPELARE

Filer
-----
frontline-pvp-server.js
FC_v6_210_ONLINE_TURN_TEST.html

Starta servern på en dator
--------------------------
1. Installera Node.js 18 eller senare på datorn.
2. Lägg serverfilen och HTML-filen i samma mapp.
3. Öppna Terminal/Kommandotolken i mappen.
4. Kör:

   node frontline-pvp-server.js

5. På samma dator öppnar du:

   http://localhost:8787/FC_v6_210_ONLINE_TURN_TEST.html

Testa med två mobiler på samma Wi-Fi
-------------------------------------
1. Ta reda på datorns lokala IP-adress, till exempel 192.168.1.25.
2. Öppna på båda mobilerna:

   http://192.168.1.25:8787/FC_v6_210_ONLINE_TURN_TEST.html

3. Du klickar SKAPA RUM.
4. Jocke skriver samma rumskod och klickar ANSLUT.
5. Du placerar HQ. Därefter turas ni om i förberedelsedragen.
6. På stor karta börjar stridsfasen på drag 31.

Om mobilerna inte når servern
-----------------------------
- Kontrollera att dator och mobiler är på samma Wi-Fi.
- Tillåt Node.js i datorns brandvägg på privat nätverk.
- Använd datorns IP-adress, inte localhost, på mobilerna.

För spel över internet
----------------------
Den här testservern måste köras på en dator eller hostas på en publik server.
Då använder båda spelarna samma https-adress. Rum och matchdata ligger bara i
minnet under testet och försvinner när serverprocessen stängs.

Testversionens upplägg
----------------------
- Servern håller rummet, gemensam karta/seed, turordning och matchfas.
- Varje spelare spelar från sin egen sida.
- Den avslutade spelarens hela spelstatus skickas till motspelaren vid
  rundbytet, så att båda klienterna fortsätter från samma läge.
- Missiler och satellit är låsta under förberedelsen enligt spelregeln.
- Detta är första fungerande nätlagret för testmatch. Ranking, återanslutning
  efter serverstopp och turneringssystem hör till senare steg.

